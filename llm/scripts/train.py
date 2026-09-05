#!/usr/bin/env python3
"""
VoidCode AI - Fine-Tuning Script (v5.2 - Hybrid Architecture)

ARCHITECTURE:
- FINE-TUNED: TEACHING, DEBUG, FOLLOWUP (custom formats)
- PROMPT-ENGINEERED: EXPLAIN (leverages base model strength)

This hybrid approach:
1. Fine-tunes only for behaviors requiring custom formats
2. Uses prompt engineering for natural explanation tasks
3. Achieves better results with focused training data

VoidCode AI
"""

import os
import sys

# Must be set before torch is imported.
# Reduces VRAM fragmentation that causes nvlddmkm.sys BSOD spikes on Windows.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# Prevent Windows TDR from killing long-running CUDA kernels during training.
os.environ.setdefault("CUDA_LAUNCH_BLOCKING", "0")

import json
import yaml
import torch
import logging
from datetime import datetime
from typing import List, Dict
from collections import Counter

from datasets import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
)
from peft import (
    LoraConfig,
    get_peft_model,
    prepare_model_for_kbit_training,
    TaskType,
)
from trl import SFTTrainer, SFTConfig

# Get project root
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Import prompts module
sys.path.insert(0, SCRIPT_DIR)
from prompts import (
    FINETUNED_SYSTEM_PROMPT,
    EXPLAIN_SYSTEM_PROMPT,
    detect_mode,
    get_generation_config,
)

# Setup logging
log_dir = os.path.join(PROJECT_ROOT, "logs")
os.makedirs(log_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(log_dir, f'training_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'))
    ]
)
logger = logging.getLogger(__name__)


def load_config(config_path: str) -> dict:
    """Load training configuration from YAML file."""
    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)
    logger.info(f"Loaded config from {config_path}")
    return config


def validate_environment():
    """Validate CUDA and GPU availability."""
    logger.info("=" * 60)
    logger.info("VOIDCODE AI v5.2 - HYBRID ARCHITECTURE")
    logger.info("=" * 60)
    logger.info("Fine-tuned: TEACHING, DEBUG, FOLLOWUP")
    logger.info("Prompt-engineered: EXPLAIN")
    logger.info("=" * 60)

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. GPU required for training.")

    gpu_name = torch.cuda.get_device_name(0)
    gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1e9

    logger.info(f"GPU: {gpu_name}")
    logger.info(f"GPU Memory: {gpu_memory:.1f} GB")
    logger.info(f"PyTorch: {torch.__version__}")
    logger.info(f"CUDA: {torch.version.cuda}")

    return True


def validate_example(example: dict) -> bool:
    """Validate a single training example for fine-tuned modes only."""
    if 'messages' not in example:
        return False

    messages = example['messages']
    if len(messages) < 3:
        return False

    mode = example.get('mode', '')

    # Only validate fine-tuned modes
    if mode not in ['teaching', 'debug', 'followup']:
        return False

    # Find assistant message
    assistant_msg = None
    for msg in messages:
        if msg.get('role') == 'assistant':
            assistant_msg = msg.get('content', '')
            break

    if not assistant_msg or len(assistant_msg.strip()) < 10:
        return False

    # Mode-specific validation
    if mode == 'teaching':
        has_explain = '[EXPLAIN]' in assistant_msg
        has_template = '[TEMPLATE]' in assistant_msg
        has_guide = '[GUIDE]' in assistant_msg
        has_blanks = '____' in assistant_msg

        if not all([has_explain, has_template, has_guide, has_blanks]):
            return False

        # Check order
        explain_pos = assistant_msg.find('[EXPLAIN]')
        template_pos = assistant_msg.find('[TEMPLATE]')
        guide_pos = assistant_msg.find('[GUIDE]')

        if not (explain_pos < template_pos < guide_pos):
            return False

    elif mode == 'debug':
        # Old format: 🔴/🟢 markers (backward compatible with v5.2 examples)
        old_format = (
            ('\U0001F534' in assistant_msg or 'Problem:' in assistant_msg) and
            ('\U0001F7E2' in assistant_msg or 'Think:' in assistant_msg)
        )
        # New format: "Issue N — Line X" headers + guiding question (v5.3)
        new_format = (
            ('Issue ' in assistant_msg or '**Issue' in assistant_msg) and
            '?' in assistant_msg and
            ('Line ' in assistant_msg or 'line ' in assistant_msg)
        )
        # Cat 4 format: correct-code confirmation (no bugs — tutor affirms and asks follow-up)
        correct_code_fmt = (
            any(phrase in assistant_msg.lower() for phrase in [
                'looks correct', 'correct to me', 'well-written', 'textbook',
                'no changes needed', 'well done', 'solution is correct',
                'is correct and', 'is correct!', 'is excellent', 'is complete and correct',
                'all tests pass', 'correctly implements', 'perfectly fine',
                "that's correct", 'excellent structure', 'very clean',
                'has excellent', 'clean and correct', 'correct and clean',
            ]) and '?' in assistant_msg
        )
        if not (old_format or new_format or correct_code_fmt):
            return False

    elif mode == 'followup':
        # Just needs content, no scaffolding
        if '[EXPLAIN]' in assistant_msg and '[TEMPLATE]' in assistant_msg:
            return False

    return True


def load_and_prepare_data(config: dict, tokenizer) -> tuple:
    """Load and prepare training data for fine-tuned modes only."""
    logger.info("=" * 60)
    logger.info("DATA PREPARATION (Fine-tuned modes only)")
    logger.info("=" * 60)

    max_seq_length = config['model']['max_seq_length']
    data_path = os.path.join(PROJECT_ROOT, config['data']['train_file'].lstrip('./'))

    # Load JSONL data
    examples = []
    with open(data_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                examples.append(json.loads(line.strip()))

    logger.info(f"Loaded {len(examples)} examples from {data_path}")

    # Validate examples
    valid_examples = []
    invalid_count = 0
    truncated_count = 0

    for ex in examples:
        if validate_example(ex):
            # Check token length
            text = tokenizer.apply_chat_template(
                ex['messages'],
                tokenize=False,
                add_generation_prompt=False
            )
            tokens = tokenizer.encode(text)
            if len(tokens) > max_seq_length:
                truncated_count += 1

            valid_examples.append(ex)
        else:
            invalid_count += 1

    logger.info(f"Valid examples: {len(valid_examples)}")
    logger.info(f"Invalid/excluded examples: {invalid_count}")
    logger.info(f"Examples exceeding max_seq_length ({max_seq_length}): {truncated_count}")

    # Log distributions
    modes = Counter(ex.get('mode', 'unknown') for ex in valid_examples)
    difficulties = Counter(ex.get('difficulty', 'unknown') for ex in valid_examples)

    logger.info(f"Mode distribution: {dict(modes)}")
    logger.info(f"Difficulty distribution: {dict(difficulties)}")

    # Format for training
    formatted_data = []
    for ex in valid_examples:
        text = tokenizer.apply_chat_template(
            ex['messages'],
            tokenize=False,
            add_generation_prompt=False
        )
        formatted_data.append({
            "text": text,
            "id": ex.get('id', ''),
            "mode": ex.get('mode', ''),
            "difficulty": ex.get('difficulty', ''),
            "problem": ex.get('problem', '')
        })

    # Create dataset and split
    dataset = Dataset.from_list(formatted_data)

    val_split = config['data'].get('validation_split', 0.1)
    test_split = config['data'].get('test_split', 0.05)

    train_test = dataset.train_test_split(test_size=val_split + test_split, seed=42)
    train_dataset = train_test['train']

    if test_split > 0:
        val_test = train_test['test'].train_test_split(
            test_size=test_split / (val_split + test_split),
            seed=42
        )
        val_dataset = val_test['train']
        test_dataset = val_test['test']
    else:
        val_dataset = train_test['test']
        test_dataset = None

    logger.info(f"Train set: {len(train_dataset)}")
    logger.info(f"Validation set: {len(val_dataset)}")
    if test_dataset:
        logger.info(f"Test set: {len(test_dataset)}")

    return train_dataset, val_dataset, test_dataset


def load_model_and_tokenizer(config: dict):
    """Load model with 4-bit quantization."""
    logger.info("=" * 60)
    logger.info("MODEL LOADING")
    logger.info("=" * 60)

    model_name = config['model']['name']
    logger.info(f"Loading: {model_name}")

    # 4-bit quantization config
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=config['model']['load_in_4bit'],
        bnb_4bit_quant_type=config['model']['bnb_4bit_quant_type'],
        bnb_4bit_compute_dtype=getattr(torch, config['model']['bnb_4bit_compute_dtype']),
        bnb_4bit_use_double_quant=True,
    )

    logger.info(f"Quantization: 4-bit NF4 with {config['model']['bnb_4bit_compute_dtype']} compute")

    # Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(
        model_name,
        trust_remote_code=True,
        padding_side="right",
    )

    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    logger.info(f"Tokenizer vocab size: {tokenizer.vocab_size}")

    # Load model
    attn_impl = None
    if config['model'].get('use_flash_attention'):
        try:
            import flash_attn
            attn_impl = "flash_attention_2"
            logger.info("Using Flash Attention 2")
        except ImportError:
            logger.warning("Flash Attention not available, using default")

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        attn_implementation=attn_impl,
    )

    logger.info("Model loaded successfully")

    # Prepare for k-bit training
    # NOTE: use_cache must be False BEFORE prepare_model_for_kbit_training
    # NOTE: pass use_gradient_checkpointing=True to avoid float32 cast OOM (PEFT 0.14+)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(
        model,
        use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
    )

    logger.info("Gradient checkpointing enabled")

    return model, tokenizer


def setup_lora(model, config: dict):
    """Configure LoRA adapters."""
    logger.info("=" * 60)
    logger.info("LoRA SETUP")
    logger.info("=" * 60)

    lora_config = LoraConfig(
        r=config['lora']['r'],
        lora_alpha=config['lora']['lora_alpha'],
        lora_dropout=config['lora']['lora_dropout'],
        target_modules=config['lora']['target_modules'],
        bias=config['lora']['bias'],
        task_type=TaskType.CAUSAL_LM,
    )

    model = get_peft_model(model, lora_config)

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())

    logger.info(f"LoRA rank: {config['lora']['r']}")
    logger.info(f"LoRA alpha: {config['lora']['lora_alpha']}")
    logger.info(f"Trainable parameters: {trainable:,} ({100*trainable/total:.2f}%)")

    return model


def create_trainer(model, tokenizer, train_dataset, val_dataset, config: dict):
    """Create SFTTrainer."""
    logger.info("=" * 60)
    logger.info("TRAINER SETUP")
    logger.info("=" * 60)

    tc = config['training']
    sft_config_dict = config.get('sft', {})
    output_dir = os.path.join(PROJECT_ROOT, tc['output_dir'].lstrip('./'))

    use_packing = sft_config_dict.get('packing', False)
    neftune_alpha = sft_config_dict.get('neftune_noise_alpha', 0)
    dataset_text_field = sft_config_dict.get('dataset_text_field', 'text')

    sft_config = SFTConfig(
        output_dir=output_dir,
        num_train_epochs=tc['num_train_epochs'],
        per_device_train_batch_size=tc['per_device_train_batch_size'],
        per_device_eval_batch_size=tc['per_device_eval_batch_size'],
        gradient_accumulation_steps=tc['gradient_accumulation_steps'],
        learning_rate=tc['learning_rate'],
        weight_decay=tc['weight_decay'],
        warmup_ratio=tc['warmup_ratio'],
        lr_scheduler_type=tc['lr_scheduler_type'],
        bf16=tc['bf16'],
        fp16=tc['fp16'],
        gradient_checkpointing=tc['gradient_checkpointing'],
        optim=tc['optim'],
        logging_steps=tc['logging_steps'],
        save_strategy=tc['save_strategy'],
        save_steps=tc['save_steps'],
        save_total_limit=tc['save_total_limit'],
        eval_strategy=tc['eval_strategy'],
        eval_steps=tc['eval_steps'],
        seed=tc['seed'],
        dataloader_num_workers=tc['dataloader_num_workers'],
        remove_unused_columns=tc['remove_unused_columns'],
        load_best_model_at_end=tc['load_best_model_at_end'],
        metric_for_best_model=tc['metric_for_best_model'],
        report_to="none",
        logging_dir=os.path.join(output_dir, "logs"),
        max_length=config['model']['max_seq_length'],
        dataset_text_field=dataset_text_field,
        packing=use_packing,
        neftune_noise_alpha=neftune_alpha if neftune_alpha > 0 else None,
    )

    effective_batch = tc['per_device_train_batch_size'] * tc['gradient_accumulation_steps']

    logger.info(f"Effective batch size: {effective_batch}")
    logger.info(f"Learning rate: {tc['learning_rate']}")
    logger.info(f"Epochs: {tc['num_train_epochs']}")
    logger.info(f"Max sequence length: {config['model']['max_seq_length']}")
    logger.info(f"Packing: {'enabled' if use_packing else 'disabled'}")

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        args=sft_config,
    )

    return trainer


def run_evaluation(model, tokenizer, test_prompts: List[Dict]) -> dict:
    """Evaluate model on test prompts for FINE-TUNED modes only.

    v5.2: Only evaluates TEACHING, DEBUG, FOLLOWUP (fine-tuned).
    EXPLAIN mode is prompt-engineered and not evaluated here.
    """
    logger.info("=" * 60)
    logger.info("EVALUATION (v5.2 - Fine-Tuned Modes Only)")
    logger.info("=" * 60)
    logger.info("Evaluating: TEACHING, DEBUG, FOLLOWUP")
    logger.info("Skipping: EXPLAIN (prompt-engineered, not fine-tuned)")

    model.eval()

    results = {
        "total": 0,
        "teaching": {"total": 0, "has_explain": 0, "has_template": 0, "has_guide": 0, "has_blanks": 0, "fully_compliant": 0},
        "debug": {"total": 0, "has_problem": 0, "has_think": 0, "no_scaffolding": 0, "fully_compliant": 0},
        "followup": {"total": 0, "has_content": 0, "no_scaffolding": 0, "fully_compliant": 0},
    }

    for prompt_info in test_prompts:
        prompt = prompt_info["prompt"]
        mode = prompt_info.get("mode", "teaching")

        # Skip EXPLAIN mode - it's prompt-engineered, not fine-tuned
        if mode == "explain":
            continue

        results["total"] += 1

        try:
            inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
            input_length = inputs["input_ids"].shape[1]

            # Get generation config for mode
            gen_config = get_generation_config(mode)

            with torch.inference_mode():
                outputs = model.generate(
                    input_ids=inputs["input_ids"],
                    attention_mask=inputs["attention_mask"],
                    max_new_tokens=gen_config['max_new_tokens'],
                    temperature=gen_config['temperature'],
                    top_p=gen_config['top_p'],
                    do_sample=gen_config['do_sample'],
                    repetition_penalty=gen_config['repetition_penalty'],
                    pad_token_id=tokenizer.pad_token_id,
                    use_cache=True,
                )

            generated_tokens = outputs[0][input_length:]
            response = tokenizer.decode(generated_tokens, skip_special_tokens=True).strip()

            compliant = False

            if mode == "teaching":
                results["teaching"]["total"] += 1

                has_explain = '[EXPLAIN]' in response
                has_template = '[TEMPLATE]' in response
                has_guide = '[GUIDE]' in response
                has_blanks = '____' in response

                compliant = all([has_explain, has_template, has_guide, has_blanks])

                if has_explain: results["teaching"]["has_explain"] += 1
                if has_template: results["teaching"]["has_template"] += 1
                if has_guide: results["teaching"]["has_guide"] += 1
                if has_blanks: results["teaching"]["has_blanks"] += 1
                if compliant: results["teaching"]["fully_compliant"] += 1

            elif mode == "debug":
                results["debug"]["total"] += 1

                has_problem = '\U0001F534' in response or 'Problem:' in response
                has_think = '\U0001F7E2' in response or 'Think:' in response
                no_scaffolding = not ('[EXPLAIN]' in response and '[TEMPLATE]' in response)

                compliant = has_problem and has_think and no_scaffolding

                if has_problem: results["debug"]["has_problem"] += 1
                if has_think: results["debug"]["has_think"] += 1
                if no_scaffolding: results["debug"]["no_scaffolding"] += 1
                if compliant: results["debug"]["fully_compliant"] += 1

            elif mode == "followup":
                results["followup"]["total"] += 1

                has_content = len(response) >= 20
                no_scaffolding = not ('[EXPLAIN]' in response and '[TEMPLATE]' in response)

                compliant = has_content and no_scaffolding

                if has_content: results["followup"]["has_content"] += 1
                if no_scaffolding: results["followup"]["no_scaffolding"] += 1
                if compliant: results["followup"]["fully_compliant"] += 1

        except Exception as e:
            logger.error(f"Evaluation error: {e}")

    # Log results
    logger.info("\n=== FINE-TUNED MODES ===")

    logger.info("\nTEACHING MODE (scaffolding):")
    t = results["teaching"]
    if t["total"] > 0:
        logger.info(f"  [EXPLAIN] Rate: {100*t['has_explain']/t['total']:.1f}%")
        logger.info(f"  [TEMPLATE] Rate: {100*t['has_template']/t['total']:.1f}%")
        logger.info(f"  [GUIDE] Rate: {100*t['has_guide']/t['total']:.1f}%")
        logger.info(f"  Blanks Rate: {100*t['has_blanks']/t['total']:.1f}%")
        logger.info(f"  Compliance: {t['fully_compliant']}/{t['total']} ({100*t['fully_compliant']/t['total']:.1f}%)")

    logger.info("\nDEBUG MODE (red/green markers):")
    d = results["debug"]
    if d["total"] > 0:
        logger.info(f"  Has Problem (red): {100*d['has_problem']/d['total']:.1f}%")
        logger.info(f"  Has Think (green): {100*d['has_think']/d['total']:.1f}%")
        logger.info(f"  No Scaffolding: {100*d['no_scaffolding']/d['total']:.1f}%")
        logger.info(f"  Compliance: {d['fully_compliant']}/{d['total']} ({100*d['fully_compliant']/d['total']:.1f}%)")

    logger.info("\nFOLLOW-UP MODE:")
    f = results["followup"]
    if f["total"] > 0:
        logger.info(f"  Has Content: {100*f['has_content']/f['total']:.1f}%")
        logger.info(f"  No Scaffolding: {100*f['no_scaffolding']/f['total']:.1f}%")
        logger.info(f"  Compliance: {f['fully_compliant']}/{f['total']} ({100*f['fully_compliant']/f['total']:.1f}%)")

    # Calculate overall for fine-tuned modes only
    ft_total = t["total"] + d["total"] + f["total"]
    ft_compliant = t["fully_compliant"] + d["fully_compliant"] + f["fully_compliant"]
    ft_rate = 100 * ft_compliant / ft_total if ft_total > 0 else 0

    logger.info(f"\n=== FINE-TUNED COMPLIANCE: {ft_compliant}/{ft_total} ({ft_rate:.1f}%) ===")

    return results


def main():
    """Main training function."""
    logger.info("=" * 60)
    logger.info("VOIDCODE AI - FINE-TUNING v5.3")
    logger.info("Hybrid Architecture: Fine-tuning + Prompt Engineering")
    logger.info("=" * 60)

    # Load config
    config_path = os.path.join(PROJECT_ROOT, "configs", "training_config.yaml")
    config = load_config(config_path)

    # Override data file for v5.3
    config['data']['train_file'] = "./data/voidcode_training_data_v53.jsonl"

    logger.info(f"Training data: {config['data']['train_file']}")
    logger.info(f"Max sequence length: {config['model']['max_seq_length']}")

    # Validate environment
    validate_environment()

    # Load model and tokenizer
    model, tokenizer = load_model_and_tokenizer(config)

    # Setup LoRA
    model = setup_lora(model, config)

    # Load data
    train_dataset, val_dataset, test_dataset = load_and_prepare_data(config, tokenizer)

    # Create trainer
    trainer = create_trainer(model, tokenizer, train_dataset, val_dataset, config)

    # Check for checkpoint
    checkpoint = None
    output_dir = os.path.join(PROJECT_ROOT, config['training']['output_dir'].lstrip('./'))
    if os.path.isdir(output_dir):
        checkpoints = [d for d in os.listdir(output_dir) if d.startswith("checkpoint-")]
        # Only consider checkpoints that have a valid trainer_state.json — an absent
        # trainer_state.json means the checkpoint write was interrupted and is corrupt.
        valid_checkpoints = [
            d for d in checkpoints
            if os.path.isfile(os.path.join(output_dir, d, "trainer_state.json"))
        ]
        invalid = set(checkpoints) - set(valid_checkpoints)
        for bad in invalid:
            logger.warning(
                f"Skipping incomplete checkpoint (no trainer_state.json): {bad}"
            )
        if valid_checkpoints:
            latest = max(valid_checkpoints, key=lambda x: int(x.split("-")[1]))
            checkpoint = os.path.join(output_dir, latest)
            logger.info(f"Resuming from: {checkpoint}")

    # Train
    logger.info("=" * 60)
    logger.info("STARTING TRAINING")
    logger.info("=" * 60)

    try:
        trainer.train(resume_from_checkpoint=checkpoint)
    except RuntimeError as e:
        if "out of memory" in str(e).lower():
            logger.error("OUT OF MEMORY - reduce batch size or sequence length")
            raise
        raise

    # Save model
    final_path = os.path.join(output_dir, "final_model")
    trainer.save_model(final_path)
    tokenizer.save_pretrained(final_path)
    logger.info(f"Model saved to: {final_path}")

    # Create test prompts
    def make_prompt(user_msg: str, mode: str) -> str:
        """Create prompt with appropriate system prompt for mode."""
        if mode == "explain":
            sys_prompt = EXPLAIN_SYSTEM_PROMPT
        else:
            sys_prompt = FINETUNED_SYSTEM_PROMPT
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_msg}
        ]
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    # Only test fine-tuned modes (EXPLAIN is prompt-engineered, tested separately)
    test_prompts = [
        # TEACHING MODE (fine-tuned)
        {"mode": "teaching", "prompt": make_prompt("How do I solve Two Sum?", "teaching")},
        {"mode": "teaching", "prompt": make_prompt("Help me implement Binary Search.", "teaching")},
        {"mode": "teaching", "prompt": make_prompt("How do I solve 3Sum efficiently?", "teaching")},
        {"mode": "teaching", "prompt": make_prompt("How do I solve Trapping Rain Water?", "teaching")},

        # DEBUG MODE (fine-tuned)
        {"mode": "debug", "prompt": make_prompt("My code doesn't work:\n```python\ndef twoSum(nums, target):\n    for i in range(len(num)):\n        return nums[i]\n```", "debug")},
        {"mode": "debug", "prompt": make_prompt("Can you help debug this?\n```python\ndef binarySearch(arr, target):\n    left, right = 0, len(arr)\n    while left < right:\n        mid = left + right / 2\n```", "debug")},
        {"mode": "debug", "prompt": make_prompt("This has a bug:\n```python\ndef reverseList(head):\n    prev = None\n    while head:\n        head.next = prev\n        prev = head\n```", "debug")},
        {"mode": "debug", "prompt": make_prompt("Why doesn't this work?\n```python\ndef isValid(s):\n    stack = []\n    for char in s:\n        if char in '({[':\n            stack.append(char)\n        else:\n            stack.pop()\n```", "debug")},

        # FOLLOW-UP MODE (fine-tuned)
        {"mode": "followup", "prompt": make_prompt("So it's O(n)?", "followup")},
        {"mode": "followup", "prompt": make_prompt("Why not use two loops?", "followup")},
    ]

    eval_results = run_evaluation(model, tokenizer, test_prompts)

    # Save results
    eval_path = os.path.join(output_dir, "evaluation_results_v52.json")
    with open(eval_path, 'w') as f:
        json.dump(eval_results, f, indent=2)

    logger.info("=" * 60)
    logger.info("TRAINING COMPLETE (v5.2 - Hybrid Architecture)")
    logger.info("=" * 60)
    logger.info(f"Model: {final_path}")
    logger.info("")
    logger.info("Fine-tuned modes (evaluated):")

    # Report fine-tuned modes only
    total_compliant = 0
    total_tests = 0
    for mode in ["teaching", "debug", "followup"]:
        m = eval_results.get(mode, {})
        mode_total = m.get("total", 0)
        mode_compliant = m.get("fully_compliant", 0)
        rate = 100 * mode_compliant / mode_total if mode_total > 0 else 0
        logger.info(f"  {mode.upper()}: {mode_compliant}/{mode_total} ({rate:.1f}%)")
        total_compliant += mode_compliant
        total_tests += mode_total

    overall_rate = 100 * total_compliant / total_tests if total_tests > 0 else 0
    logger.info("")
    logger.info(f"OVERALL FINE-TUNED COMPLIANCE: {total_compliant}/{total_tests} ({overall_rate:.1f}%)")
    logger.info("")
    logger.info("EXPLAIN mode: Handled by prompt engineering (not evaluated)")
    logger.info("  Test with: python scripts/test_model_v52.py")

    return model, tokenizer, eval_results


if __name__ == "__main__":
    main()
