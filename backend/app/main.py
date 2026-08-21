"""
Application entrypoint. Run with:
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
from the backend/ directory, with the venv active.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.health import router as health_router
from app.core.config import get_settings
from app.core.lifespan import lifespan
from app.core.logging_config import configure_logging, get_logger
from app.middleware.request_logging import RequestLoggingMiddleware

configure_logging()
logger = get_logger(__name__)
settings = get_settings()

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Medical STT/NER assisted clinical documentation system",
    version="0.1.0",
    lifespan=lifespan,
)

# Request logging must be added before routers so it wraps every request.
app.add_middleware(RequestLoggingMiddleware)

# CORS: permissive for now during local dev (frontend on a different
# port). MUST be tightened to explicit allowed origins before any real
# deployment -- flagged now, addressed properly in Phase 16 (hardening).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite's default dev port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)


@app.get("/")
async def root() -> dict:
    return {"message": f"{settings.PROJECT_NAME} API", "docs": "/docs"}