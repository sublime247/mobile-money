"""
Test runner for mobile_money_stellar SDK test suite.
"""

import sys
import unittest
from pathlib import Path

# Add sdk/python to python path
pkg_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pkg_dir))

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=str(Path(__file__).parent), pattern="test_*.py")
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
