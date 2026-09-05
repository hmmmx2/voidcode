#!/usr/bin/env python3
"""
VoidCode AI - Hybrid Architecture Test Script (v5.2)

This script tests both:
1. FINE-TUNED modes: TEACHING, DEBUG, FOLLOWUP (with LoRA adapter)
2. PROMPT-ENGINEERED mode: EXPLAIN (base model, adapter disabled)

Usage:
    python test_hybrid_model.py
    python test_hybrid_model.py --mode teaching
    python test_hybrid_model.py --interactive
"""

import os
import sys
import argparse
import torch
from contextlib import nullcontext

# Add scripts directory to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from prompts import (
    FINETUNED_SYSTEM_PROMPT,
    EXPLAIN_SYSTEM_PROMPT,
    detect_mode,
    detect_problem_paste,
    get_system_prompt,
    get_generation_config,
    strip_thinking_tags,
)

# Model configuration
BASE_MODEL_ID = os.getenv("BASE_MODEL_ID", "Qwen/Qwen2.5-7B-Instruct")
DEFAULT_ADAPTER_PATH = os.path.join(PROJECT_ROOT, "outputs", "final_model")
ADAPTER_PATH = os.getenv("ADAPTER_PATH", DEFAULT_ADAPTER_PATH)


def load_model():
    """Load the fine-tuned model with LoRA adapter."""
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from peft import PeftModel

    print("=" * 60)
    print("VOIDCODE AI v5.2 - HYBRID ARCHITECTURE TESTER")
    print("=" * 60)

    if not os.path.exists(ADAPTER_PATH):
        print(f"❌ LoRA adapter not found at: {ADAPTER_PATH}")
        print("Please ensure the model has been fine-tuned first.")
        sys.exit(1)

    print(f"Loading base model: {BASE_MODEL_ID}")
    print(f"Loading adapter from: {ADAPTER_PATH}")

    # 4-bit quantization
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    # Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_ID, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Load base model
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_ID,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )

    # Load LoRA adapter
    model = PeftModel.from_pretrained(model, ADAPTER_PATH)
    model.eval()

    print("✅ Model loaded successfully!")
    print("=" * 60)

    return model, tokenizer


def test_mode_detection():
    """Test the mode detection logic."""
    print("\n" + "=" * 60)
    print("TESTING MODE DETECTION")
    print("=" * 60)

    test_cases = [
        # Teaching mode - LeetCode style
        ("How do I solve Two Sum?", "teaching"),
        ("Implement binary search for me", "teaching"),
        
        # Teaching mode - Competitive Programming (should now work!)
        ("""You need to find at least one vertex on the path between 
        \\(x\\) and \\(y\\) using queries. The graph is a tree with n vertices.""", "teaching"),
        
        # Debug mode
        ("My code doesn't work:\n```python\ndef foo():\n    return bar\n```", "debug"),
        ("Fix this bug:\n```python\nfor i in range(len(num)):\n```", "debug"),
        
        # Explain mode
        ("What is a hash map?", "explain"),
        ("Explain how binary search works", "explain"),
        
        # Follow-up mode
        ("So it's O(n)?", "followup"),
        ("Why?", "followup"),
        
        # General mode
        ("How do I study for exams?", "general"),
    ]

    passed = 0
    failed = 0

    for user_msg, expected_mode in test_cases:
        # Also check problem paste detection
        is_problem = detect_problem_paste(user_msg)
        actual_mode = detect_mode(user_msg)
        
        status = "✅" if actual_mode == expected_mode else "❌"
        if actual_mode == expected_mode:
            passed += 1
        else:
            failed += 1

        print(f"\n{status} Expected: {expected_mode}, Got: {actual_mode}")
        print(f"   Problem Paste: {is_problem}")
        print(f"   Input: {user_msg[:60]}...")

    print(f"\n{'=' * 60}")
    print(f"Results: {passed}/{passed + failed} tests passed")
    print("=" * 60)

    return failed == 0


def generate_response(model, tokenizer, user_message: str, mode: str = None):
    """Generate a response using the hybrid architecture."""
    
    # Detect mode if not provided
    if mode is None:
        mode = detect_mode(user_message)
    
    print(f"\n🎯 Detected Mode: {mode.upper()}")
    
    # Get system prompt
    system_prompt = get_system_prompt(mode)
    
    # Get generation config
    gen_config = get_generation_config(mode)
    
    # Prepare messages
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message}
    ]
    
    # Tokenize
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(model.device)
    input_length = inputs["input_ids"].shape[1]
    
    # Determine adapter context
    # EXPLAIN and GENERAL modes use the base model (disable adapter)
    should_disable_adapter = mode in ['explain', 'general']
    adapter_context = model.disable_adapter() if should_disable_adapter else nullcontext()
    
    model_type = "🔧 BASE MODEL (Adapter Disabled)" if should_disable_adapter else "🎓 FINE-TUNED MODEL (Adapter Active)"
    print(f"   Model: {model_type}")
    
    # Generate
    with adapter_context:
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
            )
    
    # Decode
    generated_tokens = outputs[0][input_length:]
    response = tokenizer.decode(generated_tokens, skip_special_tokens=True).strip()
    
    # Strip thinking tags
    cleaned_response, thinking = strip_thinking_tags(response)
    
    return cleaned_response, thinking, mode


def validate_response(response: str, mode: str) -> dict:
    """Validate that the response matches the expected format."""
    validation = {
        "mode": mode,
        "passed": False,
        "checks": {}
    }
    
    if mode == "teaching":
        validation["checks"]["has_explain"] = "[EXPLAIN]" in response
        validation["checks"]["has_template"] = "[TEMPLATE]" in response
        validation["checks"]["has_guide"] = "[GUIDE]" in response
        validation["checks"]["has_blanks"] = "____" in response
        validation["checks"]["no_full_solution"] = response.count("def ") <= 2  # Template only
        
        validation["passed"] = all(validation["checks"].values())
        
    elif mode == "debug":
        # Old format: 🔴/🟢 markers (backward compatible with v5.2 model)
        old_fmt = (
            ("🔴" in response or "Problem:" in response) and
            ("🟢" in response or "Think:" in response)
        )
        # New format: "Issue N — Line X" headers + guiding question (v5.3)
        new_fmt = (
            ("Issue " in response or "**Issue" in response) and
            "?" in response
        )
        validation["checks"]["has_debug_format"] = old_fmt or new_fmt
        validation["checks"]["no_scaffolding"] = not ("[EXPLAIN]" in response and "[TEMPLATE]" in response)

        validation["passed"] = all(validation["checks"].values())
        
    elif mode == "explain":
        validation["checks"]["no_scaffolding"] = not ("[EXPLAIN]" in response and "[TEMPLATE]" in response)
        validation["checks"]["has_content"] = len(response) > 50
        
        validation["passed"] = all(validation["checks"].values())
        
    elif mode == "followup":
        validation["checks"]["is_brief"] = len(response.split()) < 200
        validation["checks"]["no_scaffolding"] = not ("[EXPLAIN]" in response and "[TEMPLATE]" in response)
        
        validation["passed"] = all(validation["checks"].values())
    
    else:  # general
        validation["checks"]["has_content"] = len(response) > 20
        validation["passed"] = True
    
    return validation


def run_test_suite(model, tokenizer):
    """Run the full test suite."""
    print("\n" + "=" * 60)
    print("RUNNING HYBRID MODEL TEST SUITE")
    print("=" * 60)

    test_cases = [
        # TEACHING MODE - Should use [TEMPLATE] format
        {
            "name": "Teaching: Two Sum",
            "input": "How do I solve Two Sum?",
            "expected_mode": "teaching"
        },
        {
            "name": "Teaching: Competitive Programming",
            "input": """Find at least one vertex on the path between \\(x\\) and \\(y\\) 
            in a tree with n vertices. You can use queries to check path overlap.""",
            "expected_mode": "teaching"
        },
        
        # DEBUG MODE - Should use red/green markers
        {
            "name": "Debug: Typo Bug",
            "input": "Fix this:\n```python\ndef twoSum(nums):\n    for i in range(len(num)):\n        pass\n```",
            "expected_mode": "debug"
        },
        
        # EXPLAIN MODE - Should use base model, natural language
        {
            "name": "Explain: Hash Map",
            "input": "What is a hash map and how does it work?",
            "expected_mode": "explain"
        },
        
        # FOLLOW-UP MODE - Should be brief
        {
            "name": "Follow-up: Time Complexity",
            "input": "So it's O(n)?",
            "expected_mode": "followup"
        },
    ]

    results = []

    for test in test_cases:
        print(f"\n{'=' * 60}")
        print(f"TEST: {test['name']}")
        print(f"Expected Mode: {test['expected_mode']}")
        print("=" * 60)
        
        response, thinking, actual_mode = generate_response(
            model, tokenizer, test["input"]
        )
        
        # Validate
        validation = validate_response(response, actual_mode)
        
        # Check mode match
        mode_match = actual_mode == test["expected_mode"]
        
        print(f"\n📝 Response (first 500 chars):")
        print("-" * 40)
        print(response[:500])
        if len(response) > 500:
            print("... [truncated]")
        print("-" * 40)
        
        print(f"\n✅ Mode Match: {mode_match}")
        print(f"📊 Validation: {'PASSED' if validation['passed'] else 'FAILED'}")
        for check, result in validation["checks"].items():
            status = "✅" if result else "❌"
            print(f"   {status} {check}: {result}")
        
        results.append({
            "name": test["name"],
            "mode_match": mode_match,
            "validation": validation
        })

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    passed = sum(1 for r in results if r["mode_match"] and r["validation"]["passed"])
    total = len(results)
    
    for r in results:
        status = "✅" if r["mode_match"] and r["validation"]["passed"] else "❌"
        print(f"{status} {r['name']}")
    
    print(f"\n{'=' * 60}")
    print(f"OVERALL: {passed}/{total} tests passed")
    print("=" * 60)

    return passed == total


def interactive_mode(model, tokenizer):
    """Run in interactive mode for manual testing."""
    print("\n" + "=" * 60)
    print("INTERACTIVE MODE")
    print("Type 'quit' to exit, 'mode <mode>' to force a mode")
    print("=" * 60)

    forced_mode = None

    while True:
        try:
            user_input = input("\n👤 You: ").strip()
            
            if user_input.lower() == 'quit':
                break
            
            if user_input.lower().startswith('mode '):
                forced_mode = user_input.split(' ', 1)[1].strip()
                print(f"🔧 Forced mode set to: {forced_mode}")
                continue
            
            if user_input.lower() == 'mode':
                forced_mode = None
                print("🔧 Forced mode cleared")
                continue
            
            response, thinking, mode = generate_response(
                model, tokenizer, user_input, forced_mode
            )
            
            if thinking:
                print(f"\n💭 Thinking:\n{thinking[:200]}...")
            
            print(f"\n🤖 VoidCode AI ({mode.upper()}):\n{response}")
            
            # Quick validation
            validation = validate_response(response, mode)
            if not validation["passed"]:
                print(f"\n⚠️ Format Validation Failed:")
                for check, result in validation["checks"].items():
                    if not result:
                        print(f"   ❌ {check}")

        except KeyboardInterrupt:
            break

    print("\nGoodbye!")


def main():
    parser = argparse.ArgumentParser(description="Test the VoidCode AI Hybrid Architecture")
    parser.add_argument("--mode", choices=["teaching", "debug", "explain", "followup", "general"],
                        help="Force a specific mode for testing")
    parser.add_argument("--interactive", "-i", action="store_true",
                        help="Run in interactive mode")
    parser.add_argument("--detect-only", action="store_true",
                        help="Only test mode detection (no model loading)")
    args = parser.parse_args()

    # Test mode detection first (doesn't require model)
    if args.detect_only:
        test_mode_detection()
        return

    # Load model
    model, tokenizer = load_model()

    # Test mode detection
    detection_passed = test_mode_detection()
    
    if args.interactive:
        interactive_mode(model, tokenizer)
    else:
        # Run test suite
        run_test_suite(model, tokenizer)


if __name__ == "__main__":
    main()
