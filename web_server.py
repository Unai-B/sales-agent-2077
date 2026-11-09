#!/usr/bin/env python3
"""Servidor web del agente de ventas (FastAPI + streaming SSE)."""

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent_core import DEFAULT_MODEL, build_session
from copilot.session_events import SessionEventType


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Agente de ventas")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1)
    model: str = DEFAULT_MODEL


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest):
    queue: asyncio.Queue = asyncio.Queue()

    def on_event(event):
        if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
            queue.put_nowait(("delta", event.data.delta_content or ""))
        elif event.type == SessionEventType.SESSION_ERROR:
            queue.put_nowait(("error", f"Error de sesión: {event.data}"))

    async def generate():
        try:
            client, session = await build_session(req.model, on_event)
        except Exception as exc:
            yield sse({"type": "error", "message": f"No se pudo iniciar el agente: {exc}"})
            return

        async def ask():
            try:
                response = await session.send_and_wait(req.question)
                if response is None:
                    await queue.put(("error", "El agente terminó sin responder"))
            except Exception as exc:
                await queue.put(("error", str(exc)))
            finally:
                await queue.put(("done", None))

        task = asyncio.create_task(ask())
        try:
            while True:
                kind, payload = await queue.get()
                if kind == "delta":
                    yield sse({"type": "delta", "content": payload})
                elif kind == "error":
                    yield sse({"type": "error", "message": payload})
                elif kind == "done":
                    break
            await task
        finally:
            if not task.done():
                task.cancel()
            await client.stop()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("web_server:app", host="127.0.0.1", port=8000, reload=False)
