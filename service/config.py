from __future__ import annotations

import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    fieldagent_api_keys: str = ""  # comma-separated
    cors_origins: list[str] = ["*"]
    port: int = 8080

    @property
    def api_keys(self) -> list[str]:
        return [k.strip() for k in self.fieldagent_api_keys.split(",") if k.strip()]

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
