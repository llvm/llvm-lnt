"""Environment-driven configuration."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Bump the default value to handle potentially large profile payloads. The reverse proxy in
# front of the app has to agree with this setting: keep both in sync.
DEFAULT_BODY_LIMIT = 128 * 1024 * 1024


class Settings(BaseSettings):
    """Server configuration, read from the environment.

    Instantiated through :func:`get_settings` rather than at import, so that importing the
    application never requires the environment to be populated.
    """

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str = ""
    database_ssl_ca: str | None = None
    body_limit: int = DEFAULT_BODY_LIMIT

    # Absolute path to the built client.
    client_dist: str | None = None

    @field_validator("database_url")
    @classmethod
    def _require_database_url(cls, value: str) -> str:
        if not value:
            raise ValueError("Missing required environment variable: DATABASE_URL")
        return value

    @property
    def sqlalchemy_url(self) -> str:
        """`database_url` normalized to the driver SQLAlchemy should use.

        SQLAlchemy 2.0 removed the ``postgres://`` alias outright, and bare ``postgresql://``
        resolves to psycopg2, which we do not install. Every URL in this repository and in
        deployed environments is written in one of those two forms.
        """
        for prefix in ("postgres://", "postgresql://"):
            if self.database_url.startswith(prefix):
                return "postgresql+psycopg://" + self.database_url[len(prefix) :]
        return self.database_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
