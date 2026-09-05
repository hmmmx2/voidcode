"""The read paths only, without the 7B model load — same routers, real database."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi import FastAPI
from src.routers.dashboard import router as dash
from src.routers.interviews import router as intv
from src.routers.problems import router as prob
from src.routers.recommendations import router as rec

app = FastAPI()
@app.get("/health")
def health():
    return {"status": "ok"}
for r in (rec, dash, prob, intv):
    app.include_router(r)
