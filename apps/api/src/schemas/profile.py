"""Pydantic schemas for the Profile API."""

from pydantic import BaseModel


class ProfileResponse(BaseModel):
    id: str
    email: str
    name: str
    role: str
    bio: str | None = None
    birth_date: str | None = None  # ISO date string "YYYY-MM-DD"
    age: int | None = None  # Computed from birth_date
    country: str | None = None
    occupation: str | None = None
    profile_photo_url: str | None = None
    timezone: str | None = None
    #: Whether this account has a password at all. OAuth-only accounts do not, and a
    #: change-password form rendered for one is a control that can only fail. Never
    #: the hash itself, and never anything about its strength.
    has_password: bool = False
    created_at: str
    updated_at: str


class ProfileUpdateRequest(BaseModel):
    name: str | None = None
    bio: str | None = None
    birth_date: str | None = None  # "YYYY-MM-DD"
    country: str | None = None
    occupation: str | None = None
    profile_photo_url: str | None = None
    timezone: str | None = None
