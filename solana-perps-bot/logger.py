"""
Structured logging setup using loguru.
Provides clean, timestamped logs to console and file.
"""

import sys
from pathlib import Path
from loguru import logger
from dotenv import load_dotenv
import os

load_dotenv()

# Create logs directory if it doesn't exist
log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FILE = os.getenv("LOG_FILE", "logs/bot.log")

# Remove default handler
logger.remove()

# Add console handler with color
logger.add(
    sys.stdout,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
    level=LOG_LEVEL,
    colorize=True,
)

# Add file handler (rotating, 10MB per file, keep 5 backups)
logger.add(
    LOG_FILE,
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}",
    level=LOG_LEVEL,
    rotation="10 MB",
    retention=5,
)

logger.info(f"Logging initialized | Level: {LOG_LEVEL} | File: {LOG_FILE}")
