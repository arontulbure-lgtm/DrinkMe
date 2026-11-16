"""DrinkMe ai-service: FastAPI app. Run: python -m app.main (from ai-service/)."""
from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import imaging
from .config import Settings, load_settings
from .ollama_client import ModelInvalidOutput, ModelTimeout, ModelUnavailable, OllamaClient
from .pipeline import run_recipes, run_scan
from .schemas import HealthResponse, RecipeRequest, RecipeResponse, ScanRequest, ScanResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ai-service")

PUBLIC_PATHS = {"/health", "/v1/health"}


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def create_app(settings: Settings | None = None, client: OllamaClient | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.client = client or OllamaClient(settings)
        yield
        await app.state.client.close()

    app = FastAPI(title="DrinkMe ai-service", version="1.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings

    @app.middleware("http")
    async def auth_and_access_log(request: Request, call_next):
        # Access log without bodies: photos and ingredient lists never reach the log.
        if request.url.path not in PUBLIC_PATHS and settings.token:
            supplied = request.headers.get("x-ai-service-token", "")
            if not hmac.compare_digest(supplied.encode(), settings.token.encode()):
                return error(401, "unauthorized", "Missing or wrong service token")
        response = await call_next(request)
        log.info("%s %s %s", request.method, request.url.path, response.status_code)
        return response

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(_request: Request, _exc: RequestValidationError):
        # The error detail can echo the input (base64 photos), so it is not returned or logged.
        return error(422, "invalid_request", "Request does not match schema v1")

    @app.exception_handler(imaging.ImageInvalid)
    async def on_image_invalid(_request: Request, exc: imaging.ImageInvalid):
        return error(400, "image_invalid", str(exc))

    @app.exception_handler(ModelUnavailable)
    async def on_unavailable(_request: Request, _exc: ModelUnavailable):
        return error(503, "model_unavailable", "The model is not available")

    @app.exception_handler(ModelTimeout)
    async def on_timeout(_request: Request, _exc: ModelTimeout):
        return error(504, "model_timeout", "The model took too long")

    @app.exception_handler(ModelInvalidOutput)
    async def on_invalid(_request: Request, _exc: ModelInvalidOutput):
        return error(502, "model_invalid_output", "The model returned invalid output")

    async def health() -> HealthResponse:
        models = await app.state.client.list_models()
        wanted = {settings.vision_model, settings.text_model}
        present = wanted.issubset(set(models))
        ocr = settings.ocr_enabled and imaging.ocr_available()
        ok = bool(models) and present
        return HealthResponse(
            status="ok" if ok else "degraded",
            models={"vision": settings.vision_model, "text": settings.text_model},
            ollama=bool(models), modelsPresent=present, ocr=ocr,
        )

    app.get("/health", response_model=HealthResponse)(health)
    app.get("/v1/health", response_model=HealthResponse)(health)

    @app.post("/v1/scan", response_model=ScanResult)
    async def scan(req: ScanRequest) -> ScanResult:
        return await run_scan(req, app.state.client, settings)

    @app.post("/v1/recipes", response_model=RecipeResponse)
    async def recipes(req: RecipeRequest) -> RecipeResponse:
        return await run_recipes(req, app.state.client, settings)

    return app


def main() -> None:
    import uvicorn

    settings = load_settings()
    if not settings.is_loopback and not settings.token:
        raise SystemExit("Refusing to listen on a non-loopback host without AI_SERVICE_TOKEN")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="warning",
                access_log=False)


if __name__ == "__main__":
    main()
