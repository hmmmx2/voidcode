"""Pydantic schemas for the Draft API."""

from pydantic import BaseModel


class DraftUpsertRequest(BaseModel):
    problem_id: str   # UUID string
    language: str
    source_code: str


class DraftResponse(BaseModel):
    id: str
    problem_id: str
    language: str
    source_code: str
    updated_at: str
