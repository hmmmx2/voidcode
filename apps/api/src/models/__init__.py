"""SQLAlchemy models — import all so Alembic sees them.

A model left out of this file is a table `alembic revision --autogenerate` will emit DROP TABLE for.
`tests/test_migrations_match_models_postgres.py` fails when that happens.
"""

from .auth_token import AuthToken
from .catalogue import (
    DailyDelivery,
    InterviewAttempt,
    InterviewQuestion,
    Paper,
    PaperProgress,
    Project,
    ProjectSession,
)
from .chat import ChatMessage, ChatSession
from .credit_voucher import CreditVoucher
from .draft import CodeDraft
from .gpu_billing import GpuGrantKey, GpuLedger, GpuReservation, GpuWallet
from .gpu_queue import GpuQueueTicket, GpuSlot
from .knowledge import KnowledgeDocument
from .notification import Notification
from .problem import CodeTemplate, Problem, TestCase
from .problem_concept import ProblemConcept
from .submission import Submission, TestCaseResult
from .user import User, UserPreferences
from .user_identity import UserIdentity

__all__ = [
    "AuthToken",
    "ChatMessage",
    "ChatSession",
    "CodeDraft",
    "CodeTemplate",
    "CreditVoucher",
    "DailyDelivery",
    "GpuGrantKey",
    "GpuLedger",
    "GpuQueueTicket",
    "GpuReservation",
    "GpuSlot",
    "GpuWallet",
    "InterviewAttempt",
    "InterviewQuestion",
    "KnowledgeDocument",
    "Notification",
    "Paper",
    "PaperProgress",
    "Problem",
    "ProblemConcept",
    "Project",
    "ProjectSession",
    "Submission",
    "TestCase",
    "TestCaseResult",
    "User",
    "UserIdentity",
    "UserPreferences",
]
