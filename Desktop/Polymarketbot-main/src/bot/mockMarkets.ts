// Mock markets with actual pricing edges for testing
export const MOCK_MARKETS = [
  {
    conditionId: "mock-1",
    condition_id: "mock-1",
    question: "Will Bitcoin reach $100k by end of 2024?",
    outcomes: ["Yes", "No"],
    prices: [0.35, 0.65], // Yes underpriced (edge = 0.30)
  },
  {
    conditionId: "mock-2",
    condition_id: "mock-2",
    question: "Will Ethereum reach $5k by end of 2024?",
    outcomes: ["Yes", "No"],
    prices: [0.40, 0.60], // Yes underpriced (edge = 0.20)
  },
  {
    conditionId: "mock-3",
    condition_id: "mock-3",
    question: "Will AI be the top news story of 2024?",
    outcomes: ["Yes", "No"],
    prices: [0.25, 0.75], // Yes underpriced (edge = 0.50)
  },
  {
    conditionId: "mock-4",
    condition_id: "mock-4",
    question: "Will Tesla stock reach $300 by end of 2024?",
    outcomes: ["Yes", "No"],
    prices: [0.30, 0.70], // Yes underpriced (edge = 0.40)
  },
  {
    conditionId: "mock-5",
    condition_id: "mock-5",
    question: "Will US unemployment stay below 4%?",
    outcomes: ["Yes", "No"],
    prices: [0.45, 0.55], // Yes underpriced (edge = 0.10)
  },
];
