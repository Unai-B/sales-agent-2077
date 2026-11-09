#!/usr/bin/env python3
"""Agente de ventas extraído del notebook de Colab (CLI)."""

import argparse
import asyncio
import sys

from copilot.session_events import SessionEventType

from agent_core import DB_PATH, DEFAULT_MODEL, build_session


async def run(question: str | None, model: str) -> None:
    # En Windows stdout/stderr usan por defecto cp1252, que no puede
    # codificar emojis ni algunos acentos que devuelve el modelo.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")

    if not DB_PATH.is_file():
        raise FileNotFoundError(f"No existe la base de datos: {DB_PATH}")

    def on_event(event):
        if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
            sys.stdout.write(event.data.delta_content or "")
            sys.stdout.flush()
        elif event.type == SessionEventType.SESSION_ERROR:
            print(f"\nError de sesión: {event.data}", file=sys.stderr)

    client, session = await build_session(model, on_event)
    try:
        async def ask(prompt: str) -> None:
            response = await session.send_and_wait(prompt)
            if response is None:
                raise RuntimeError("El agente terminó sin responder")
            print()

        if question:
            await ask(question)
        else:
            print("📊 Agente de ventas. Escribe 'salir' para terminar.")
            while True:
                try:
                    prompt = input("Tú: ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break
                if prompt.lower() in {"salir", "exit", "quit"}:
                    break
                if prompt:
                    print("Asistente: ", end="", flush=True)
                    await ask(prompt)
    finally:
        await client.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Agente de análisis de ventas")
    parser.add_argument("--pregunta", help="Pregunta única, sin abrir el modo interactivo")
    parser.add_argument("--modelo", default=DEFAULT_MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.pregunta, args.modelo))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
