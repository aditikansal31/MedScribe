"""
Centralized application settings, loaded from environment variables (.env).
Using pydantic-settings means every config value is TYPED and VALIDATED at
startup -- if a required variable is missing or malformed, the app fails to
boot immediately with a clear error, rather than failing later mid-request
in a way that's hard to trace. This is a deliberate production-safety choice.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",  # backend/app/core -> project root .env
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ==== Project ====
    PROJECT_NAME: str = "medstt"
    ENVIRONMENT: str = "development"

    # ==== Postgres ====
    POSTGRES_USER: str
    POSTGRES_PASSWORD: str
    POSTGRES_DB: str
    POSTGRES_PORT: int = 5432
    POSTGRES_HOST: str = "postgres"

    # ==== Redis ====
    REDIS_PORT: int = 6379
    REDIS_HOST: str = "redis"
    REDIS_PASSWORD: str

    @property
    def DATABASE_URL_ASYNC(self) -> str:
        """Async connection string, used by the FastAPI app at runtime (asyncpg driver)."""
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@localhost:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def DATABASE_URL_SYNC(self) -> str:
        """Sync connection string, used only by Alembic's migration runner."""
        return (
            f"postgresql+psycopg2://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@localhost:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def REDIS_URL(self) -> str:
        return f"redis://:{self.REDIS_PASSWORD}@localhost:{self.REDIS_PORT}/0"


@lru_cache
def get_settings() -> Settings:
    """
    Cached settings instance -- .env is read from disk only once per process,
    not on every request. Safe because config doesn't change at runtime.
    """
    return Settings()
