/**
 * Direct questions: high-signal "I need a reply" emails.
 * The analyzer eval suite should mark these as needs_reply=true.
 *
 * @type {import("./types.mjs").SeedFixture[]}
 */
export const directQuestions = [
  {
    id: "dq-1-review-by-tuesday",
    from: "Alice Chen <alice.chen@acme.test>",
    subject: "Quick favor: can you review the Q3 plan by Tuesday?",
    body: [
      "Hey,",
      "",
      "Could you take a pass at the Q3 plan doc before Tuesday's exec sync?",
      "I'm specifically looking for feedback on the staffing assumptions in section 3.",
      "",
      "Doc: https://example.test/q3-plan",
      "",
      "Thanks!",
      "Alice",
    ].join("\n"),
  },
  {
    id: "dq-2-budget-numbers",
    from: "Bob Patel <bob.patel@northwind.test>",
    subject: "Do you have the FY26 budget numbers?",
    body: [
      "Hi,",
      "",
      "Finance is asking for the FY26 ops budget breakdown by EOD. I have everything except",
      "your team's headcount projections. Can you send those over?",
      "",
      "Bob",
    ].join("\n"),
  },
  {
    id: "dq-3-customer-call",
    from: "Carol Schmidt <carol@partner-co.test>",
    subject: "Customer call tomorrow — any prep materials?",
    body: [
      "Hey there,",
      "",
      "We've got the BigCo call at 10am tomorrow. Do you have any prep materials or talking points",
      "you want me to review beforehand? Want to make sure we're aligned on the pricing question.",
      "",
      "Carol",
    ].join("\n"),
  },
  {
    id: "dq-4-design-review",
    from: "Dana Wright <dana.w@designstudio.test>",
    subject: "Design review needed: onboarding v2",
    body: [
      "Putting the onboarding v2 designs up for review. Three approaches inside — would love your",
      "take on which direction feels right given the constraints we discussed.",
      "",
      "Figma: https://example.test/figma/onboarding-v2",
      "",
      "Goal is to land on a direction by Friday.",
      "",
      "— Dana",
    ].join("\n"),
  },
  {
    id: "dq-5-hiring-pipeline",
    from: "Eli Rashid <eli.r@example.test>",
    subject: "Can we sync on the hiring pipeline?",
    body: [
      "Quick one: I have 4 senior eng candidates moving toward final round and",
      "I want to make sure we're calibrated on the bar. 30 min sometime this week?",
      "",
      "Eli",
    ].join("\n"),
  },
];
