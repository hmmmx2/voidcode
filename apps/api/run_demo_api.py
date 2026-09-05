import os

os.environ["USE_SGLANG"] = "true"
os.environ["USE_VLLM"] = "false"
os.environ["SGLANG_BASE_URL"] = "http://127.0.0.1:11434/v1"   # Ollama OpenAI-compatible
os.environ["SGLANG_MODEL_NAME"] = "qwen3:8b"                   # native <think> reasoning
os.environ["SGLANG_TIMEOUT_SECONDS"] = "120"
os.environ["RANKER_PATH"] = r"C:/Users/User/Documents/DUNE project/swinburne_ai_tutor_project/models/ranker_demo.txt"
import uvicorn

uvicorn.run("src.main:app", host="0.0.0.0", port=8020, log_level="info")
