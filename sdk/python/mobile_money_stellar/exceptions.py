"""
Custom exceptions for mobile_money_stellar Python SDK.
"""

from typing import Any, Optional


class BridgeError(Exception):
    """Base exception for all Bridge API operations."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
        details: Optional[Any] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details

    def __str__(self) -> str:
        if self.status_code:
            return f"[{self.status_code}] {self.message}"
        return self.message


class ValidationError(BridgeError):
    """Raised when client-side parameter validation fails."""

    def __init__(self, message: str, details: Optional[Any] = None):
        super().__init__(message, status_code=400, code="VALIDATION_ERROR", details=details)


class AuthenticationError(BridgeError):
    """Raised when authentication credentials or token are invalid."""

    def __init__(self, message: str, details: Optional[Any] = None):
        super().__init__(message, status_code=401, code="AUTHENTICATION_FAILED", details=details)


class NotFoundError(BridgeError):
    """Raised when a requested resource does not exist."""

    def __init__(self, message: str, details: Optional[Any] = None):
        super().__init__(message, status_code=404, code="NOT_FOUND", details=details)
