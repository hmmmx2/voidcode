"""SQLAlchemy models — import all so Alembic sees them."""

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
from .draft import CodeDraft
from .knowledge import KnowledgeDocument
from .notification import Notification
from .problem import CodeTemplate, Problem, TestCase
from .problem_concept import ProblemConcept
from .submission import Submission, TestCaseResult
from .user import User, UserPreferences

__all__ = [
    "AuthToken",
    "ChatMessage",
    "ChatSession",
    "CodeDraft",
    "CodeTemplate",
    "DailyDelivery",
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
    "UserPreferences",
]
