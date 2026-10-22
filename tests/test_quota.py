import unittest

from src.quota import safe_window


class QuotaWindowTests(unittest.TestCase):
    def test_used_percent_is_not_remaining_percent(self):
        weekly = safe_window({"windowDurationMins": 10080, "usedPercent": 100})
        self.assertEqual(weekly["remainingPercent"], 0)

        renewed = safe_window({"windowDurationMins": 10080, "usedPercent": 0})
        self.assertEqual(renewed["remainingPercent"], 100)


if __name__ == "__main__":
    unittest.main()
