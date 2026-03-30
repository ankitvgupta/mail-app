import type { Email, SentEmail } from "../../shared/types";

// Comprehensive fake inbox for demo and testing
// Includes threading, various email types, and realistic scenarios

const now = Date.now();
const hour = 60 * 60 * 1000;
const day = 24 * hour;

// Rich HTML email body for testing reply/forward quoting
const RICH_HTML_EMAIL_BODY = `<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333;">
  <div style="max-width: 600px;">
    <p>Hi there,</p>

    <p>Here's the <strong>quarterly report</strong> you requested. Please review the <em>key metrics</em> below:</p>

    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; margin: 16px 0;">
      <tr style="background-color: #f5f5f5;">
        <th>Metric</th>
        <th>Q3 Value</th>
        <th>Q4 Target</th>
      </tr>
      <tr>
        <td>Revenue</td>
        <td style="color: green;">$1.2M</td>
        <td>$1.5M</td>
      </tr>
      <tr>
        <td>Active Users</td>
        <td style="color: green;">45,000</td>
        <td>60,000</td>
      </tr>
      <tr>
        <td>Retention</td>
        <td style="color: orange;">72%</td>
        <td>80%</td>
      </tr>
    </table>

    <p>Key highlights:</p>
    <ul style="margin-left: 20px;">
      <li>Revenue grew <span style="color: green; font-weight: bold;">15%</span> month-over-month</li>
      <li>New feature launch drove <strong>2,000 signups</strong></li>
      <li>Customer satisfaction score: <span style="background-color: #e8f5e9; padding: 2px 6px; border-radius: 4px;">4.8/5.0</span></li>
    </ul>

    <p>You can view the full dashboard here: <a href="https://dashboard.example.com/q3-report" style="color: #1a73e8;">Q3 Report Dashboard</a></p>

    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #ddd;">
      <p style="margin: 0;">Best regards,</p>
      <p style="margin: 4px 0; font-weight: bold;">Garry Tan</p>
      <p style="margin: 0; color: #666; font-size: 12px;">Head of Analytics | TechCorp Inc.</p>
      <img src="https://via.placeholder.com/100x30?text=TechCorp" alt="TechCorp Logo" style="margin-top: 8px;">
    </div>
  </div>
</body>
</html>`;

// Email with inline images (data: URIs) — simulates what extractBodyWithImages produces
// after resolving CID references from the MIME structure
const INLINE_IMAGE_EMAIL_BODY = `<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333;">
  <div style="max-width: 600px;">
    <p>Hi team,</p>
    <p>Here are the design mockups for the new landing page. Please review and share your feedback:</p>

    <div style="margin: 16px 0;">
      <p style="font-weight: bold; margin-bottom: 8px;">Hero Section:</p>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAA8CAYAAAAjW/WRAAAAuUlEQVR4nO3ToRHAIADAQPZiuw6NhQV6sSBevI/JmN/awL9xOwBeZhAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgWAQCAaBYBAIBoFgEAgGgXAAKNRfIwdewfoAAAAASUVORK5CYII=" alt="Hero section mockup" style="max-width: 100%; border: 1px solid #ddd; border-radius: 8px;">
    </div>

    <div style="margin: 16px 0;">
      <p style="font-weight: bold; margin-bottom: 8px;">Product Features Grid:</p>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAA8CAYAAAAjW/WRAAAAuUlEQVR4nO3TMRHAIADAQLQgrG7RBQZ6WWH44fcsGXN9G/g3bgfAywwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAMAsEgEAwCwSAQDALBIBAO2wk5t07OqqEAAAAASUVORK5CYII=" alt="Features grid mockup" style="max-width: 100%; border: 1px solid #ddd; border-radius: 8px;">
    </div>

    <p>Let me know which direction you prefer. I can iterate on the selected option by Thursday.</p>

    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #ddd;">
      <p style="margin: 0;">Cheers,</p>
      <p style="margin: 4px 0; font-weight: bold;">Surbhi Sarna</p>
      <p style="margin: 0; color: #666; font-size: 12px;">Senior Designer | CreativeStudio</p>
    </div>
  </div>
</body>
</html>`;

export const DEMO_INBOX_EMAILS: Email[] = [
  // Rich HTML email for testing quoting (first so it's easy to find)
  {
    id: "demo-html-001",
    threadId: "thread-html-report",
    subject: "Q3 Quarterly Report - Action Required",
    from: "Garry Tan <garry.tan@techcorp.com>",
    to: "me@example.com",
    date: new Date(now - 15 * 60 * 1000).toISOString(), // 15 mins ago (shows first)
    body: RICH_HTML_EMAIL_BODY,
    snippet: "Hi there, Here's the quarterly report you requested...",
    attachments: [
      {
        id: "0-Q3_Report_2025.pdf",
        filename: "Q3_Report_2025.pdf",
        mimeType: "application/pdf",
        size: 2_457_600,
        attachmentId: "demo-att-pdf-001",
      },
      {
        id: "1-Q3_Metrics.xlsx",
        filename: "Q3_Metrics.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 184_320,
        attachmentId: "demo-att-xlsx-001",
      },
      {
        id: "2-revenue_chart.png",
        filename: "revenue_chart.png",
        mimeType: "image/png",
        size: 542_720,
        attachmentId: "demo-att-png-001",
      },
    ],
  },

  // Thread 1: Project discussion (3 emails in thread)
  {
    id: "demo-001",
    threadId: "thread-project-alpha",
    subject: "Project Alpha - Timeline Discussion",
    from: "Jared Friedman <jared.friedman@acmecorp.com>",
    to: "me@example.com",
    date: new Date(now - 2 * day).toISOString(),
    body: `Hi,

I wanted to kick off the discussion about Project Alpha's timeline. Based on our initial assessment, we're looking at a 6-week development cycle.

Key milestones:
- Week 1-2: Design and architecture
- Week 3-4: Core implementation
- Week 5-6: Testing and polish

Can you review and let me know if this aligns with your expectations?

Thanks,
Jared`,
    snippet: "I wanted to kick off the discussion about Project Alpha's timeline...",
  },
  {
    id: "demo-002",
    threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "Michael Seibel <michael.s@acmecorp.com>",
    to: "me@example.com, jared.friedman@acmecorp.com",
    cc: "engineering-leads@acmecorp.com",
    date: new Date(now - 1.5 * day).toISOString(),
    body: `Jared, team,

The timeline looks reasonable. I'd suggest we add a buffer week for unexpected issues - we've learned from past projects that 6 weeks often turns into 7-8.

Also, should we schedule a kickoff meeting for Monday?

Michael`,
    snippet: "The timeline looks reasonable. I'd suggest we add a buffer week...",
  },
  {
    id: "demo-003",
    threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "Jared Friedman <jared.friedman@acmecorp.com>",
    to: "me@example.com, michael.s@acmecorp.com",
    cc: "engineering-leads@acmecorp.com, product-team@acmecorp.com",
    date: new Date(now - 1 * hour).toISOString(),
    body: `Good point Michael. Let's plan for 7 weeks then.

@me - can you confirm your availability for a Monday kickoff? I'm thinking 10am PT works for everyone.

Also, we'll need your input on the technical architecture decisions before we finalize the design phase.

Jared`,
    snippet: "Good point Michael. Let's plan for 7 weeks then. Can you confirm your availability...",
  },

  // Thread 2: API question (single email, needs reply)
  {
    id: "demo-004",
    threadId: "thread-api-question",
    subject: "Quick question about API rate limits",
    from: "Gustaf Alströmer <gustaf.a@startup.io>",
    to: "me@example.com",
    date: new Date(now - 3 * hour).toISOString(),
    body: `Hey!

We're integrating with your API and running into rate limiting issues. Currently seeing 429 errors when we try to make more than 100 requests per minute.

Questions:
1. Is there a way to increase our rate limit for production use?
2. Should we implement exponential backoff, or is there a webhook alternative?
3. Do you have any batch endpoints we could use instead?

We're planning to go live next week, so any guidance would be super helpful!

Thanks,
Gustaf`,
    snippet: "We're integrating with your API and running into rate limiting issues...",
  },

  // Thread 3: Meeting follow-up (needs reply, high priority)
  {
    id: "demo-005",
    threadId: "thread-q4-planning",
    subject: "Meeting Follow-up: Q4 Planning - Action Items",
    from: "Diana Hu <d.hu@techcorp.com>",
    to: "me@example.com",
    date: new Date(now - 30 * 60 * 1000).toISOString(), // 30 mins ago
    body: `Hi,

Great discussion in today's Q4 planning meeting! Here are the action items I captured:

ACTION ITEMS FOR YOU:
1. Review the budget proposal by EOD Wednesday
2. Provide headcount recommendations for the new initiative
3. Confirm the technical feasibility of the proposed timeline

I've attached the spreadsheet with the detailed breakdown. Let me know if you have any questions or if I missed anything.

Can we schedule a quick sync tomorrow to finalize before the exec review?

Best,
Diana`,
    snippet: "Great discussion in today's Q4 planning meeting! Action items for you...",
  },

  // GitHub notification (skip)
  {
    id: "demo-006",
    threadId: "thread-github-ci",
    subject: "[myorg/myrepo] CI workflow failed on main",
    from: "GitHub <noreply@github.com>",
    to: "me@example.com",
    date: new Date(now - 4 * hour).toISOString(),
    body: `The workflow "CI" in repository myorg/myrepo has failed.

Commit: abc123def456
Message: Update dependencies
Author: dependabot[bot]

Failed jobs:
- test (ubuntu-latest)

View the workflow run: https://github.com/myorg/myrepo/actions/runs/12345

---
You are receiving this because you are subscribed to this repository.`,
    snippet: "The workflow CI in repository myorg/myrepo has failed...",
  },

  // Newsletter (skip)
  {
    id: "demo-007",
    threadId: "thread-newsletter",
    subject: "This Week in Tech: AI Developments, Cloud Trends & More",
    from: "Tech Weekly <newsletter@techweekly.com>",
    to: "me@example.com",
    date: new Date(now - 6 * hour).toISOString(),
    body: `<html>
<body style="font-family: Georgia, serif; color: #333; background: #f9f9f9;">
<div style="max-width: 600px; margin: 0 auto; background: white; border: 1px solid #e0e0e0;">
  <div style="background-color: #1a1a2e; color: white; padding: 20px; text-align: center;">
    <h2 style="margin: 0;">Tech Weekly Newsletter</h2>
    <p style="margin: 4px 0 0; color: #aaa; font-size: 13px;">January 2025</p>
  </div>
  <div style="padding: 20px;">
    <h3>TOP STORIES THIS WEEK</h3>
    <div style="margin-bottom: 16px;">
      <strong>1. Major AI Breakthrough in Reasoning</strong>
      <p>Leading AI labs announced significant improvements in model reasoning capabilities...</p>
    </div>
    <div style="margin-bottom: 16px;">
      <strong>2. Cloud Computing Costs Continue to Drop</strong>
      <p>AWS, Azure, and GCP all announced price reductions for compute instances...</p>
    </div>
    <div style="margin-bottom: 16px;">
      <strong>3. Open Source Spotlight: New Database Takes On PostgreSQL</strong>
      <p>A new entrant in the database space promises 10x performance improvements...</p>
    </div>
    <hr style="border: none; border-top: 1px solid #ddd;">
    <p style="color: #999; font-size: 12px; text-align: center;">
      Read more at techweekly.com<br>
      <a href="https://techweekly.com/unsubscribe?id=abc123" style="color: #999;">Unsubscribe</a> from this newsletter
    </p>
  </div>
</div>
</body>
</html>`,
    snippet: "TOP STORIES THIS WEEK: Major AI Breakthrough in Reasoning...",
  },

  // Amazon shipping (skip)
  {
    id: "demo-008",
    threadId: "thread-amazon-ship",
    subject: "Your Amazon order has shipped!",
    from: "Amazon.com <ship-confirm@amazon.com>",
    to: "me@example.com",
    date: new Date(now - 8 * hour).toISOString(),
    body: `<html>
<body style="font-family: Arial, sans-serif; color: #333;">
<div style="max-width: 600px; margin: 0 auto;">
  <div style="background-color: #232f3e; color: white; padding: 16px 20px;">
    <strong>Amazon.com</strong> — Order Confirmation
  </div>
  <div style="padding: 20px;">
    <p>Your Amazon.com order <strong>#123-4567890-1234567</strong> has shipped!</p>
    <p><strong>Tracking Number:</strong> 1Z999AA10123456784 (UPS)</p>
    <p><strong>Estimated delivery:</strong> Friday, January 24</p>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
    <p><strong>Items in this shipment:</strong></p>
    <ul>
      <li>USB-C Hub (1)</li>
      <li>Mechanical Keyboard (1)</li>
      <li>Monitor Stand (1)</li>
    </ul>
    <p><strong>Order Total:</strong> $189.97</p>
    <p style="color: #666; font-size: 12px; margin-top: 24px;">
      Thank you for shopping with Amazon.<br>
      <a href="https://www.amazon.com/gp/css/unsubscribe/confirm.html">Unsubscribe</a> from shipping notifications.
    </p>
  </div>
</div>
</body>
</html>`,
    snippet: "Your Amazon.com order has shipped! Estimated delivery Friday...",
  },

  // Thread 4: Interview scheduling (needs reply)
  {
    id: "demo-009",
    threadId: "thread-interview",
    subject: "Interview Scheduling - Senior Engineer Candidate",
    from: "HR Team <recruiting@acmecorp.com>",
    to: "me@example.com",
    date: new Date(now - 5 * hour).toISOString(),
    body: `Hi,

We have a strong candidate for the Senior Engineer position and would like to schedule a technical interview.

Candidate: Jordan Smith
Experience: 8 years, previously at Google and Stripe
Focus areas: Distributed systems, API design

Available slots next week:
- Tuesday 2pm-3pm PT
- Wednesday 10am-11am PT
- Thursday 3pm-4pm PT

Could you confirm which slot works for you? Please also let me know if you'd like to see their resume beforehand.

Thanks!
HR Team`,
    snippet: "We have a strong candidate for the Senior Engineer position...",
  },

  // Personal email (needs reply, medium priority)
  {
    id: "demo-010",
    threadId: "thread-lunch",
    subject: "Lunch this week?",
    from: "Tom Blomfield <tom.blomfield@gmail.com>",
    to: "me@example.com",
    date: new Date(now - 1 * day).toISOString(),
    body: `Hey!

It's been a while since we caught up. Want to grab lunch this week? I'm free Thursday or Friday.

There's a new ramen place downtown that got great reviews - we could check it out.

Let me know!
Tom`,
    snippet: "It's been a while since we caught up. Want to grab lunch this week?",
  },

  // Calendar invite response (skip)
  {
    id: "demo-011",
    threadId: "thread-calendar",
    subject: "Accepted: Weekly Team Sync @ Mon Jan 27, 2025 10am - 11am (PT)",
    from: "Google Calendar <calendar-notification@google.com>",
    to: "me@example.com",
    date: new Date(now - 12 * hour).toISOString(),
    body: `Jared Friedman has accepted this invitation.

Weekly Team Sync
When: Monday, January 27, 2025 10:00am - 11:00am PT
Where: Conference Room A / Zoom

Going: jared.friedman@acmecorp.com
Awaiting: michael.s@acmecorp.com, you`,
    snippet: "Jared Friedman has accepted this invitation. Weekly Team Sync...",
  },

  // Thread 5: Bug report (needs reply, high priority)
  {
    id: "demo-012",
    threadId: "thread-bug-report",
    subject: "URGENT: Production issue affecting checkout flow",
    from: "On-Call <oncall@acmecorp.com>",
    to: "me@example.com",
    date: new Date(now - 15 * 60 * 1000).toISOString(), // 15 mins ago
    body: `INCIDENT ALERT

Severity: P1
Status: Investigating
Affected: Checkout flow - payment processing

Issue:
Users are reporting failed payments with error code PAYMENT_TIMEOUT. Started approximately 20 minutes ago.

Current impact:
- ~5% of checkout attempts failing
- Estimated revenue impact: $2,000/hour

We need your expertise on the payment integration. Can you join the incident channel?

Slack: #incident-checkout-012
Zoom: https://zoom.us/j/123456789

---
On-Call Team`,
    snippet: "URGENT: Production issue affecting checkout flow. P1 severity...",
  },

  // Thread 6: Scheduling email (needs reply, tests EA integration)
  {
    id: "demo-meeting",
    threadId: "thread-meeting-request",
    subject: "Coffee chat to discuss partnership opportunity",
    from: "Kat Mañalac <kat.m@partnerco.com>",
    to: "me@example.com",
    date: new Date(now - 4 * hour).toISOString(),
    body: `Hi,

I hope this email finds you well! I'm the Head of Business Development at PartnerCo.

I've been following your company's work in the AI space and I'd love to schedule a call to discuss potential partnership opportunities. I think there could be some great synergies between our platforms.

Would you have 30 minutes sometime next week for a quick call? I'm flexible with timing and can work around your schedule.

Looking forward to connecting!

Best regards,
Kat Mañalac
Head of Business Development
PartnerCo`,
    snippet: "I'd love to schedule a call to discuss potential partnership opportunities...",
  },

  // Email with inline images (tests inline image rendering)
  {
    id: "demo-inline-images",
    threadId: "thread-inline-images",
    subject: "Landing Page Mockups - Inline Images",
    from: "Surbhi Sarna <surbhi.sarna@creativestudio.com>",
    to: "me@example.com",
    date: new Date(now - 3 * hour).toISOString(),
    body: INLINE_IMAGE_EMAIL_BODY,
    snippet: "Here are the design mockups for the new landing page...",
  },

  // User's sent reply in the Project Alpha thread (tests archive-ready with sent emails)
  {
    id: "demo-sent-reply-001",
    threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "me@example.com",
    to: "jared.friedman@acmecorp.com, michael.s@acmecorp.com",
    date: new Date(now - 25 * 60 * 1000).toISOString(), // 25 mins ago
    body: `Jared, Michael,

Monday at 10am PT works perfectly for the kickoff. I'll have my calendar blocked.

For the architecture, I can prepare a brief overview of the key decisions:
- Database schema design
- API structure and versioning
- Authentication approach

I'll share a doc before the meeting so we can hit the ground running. 7 weeks with the buffer week sounds right.

Talk soon!`,
    snippet: "Monday at 10am PT works perfectly for the kickoff...",
    labelIds: ["SENT"],
  },

  // === STYLE TESTING: Casual contact (Dalton Caldwell) ===
  // Inbox email from Dalton that needs a reply
  {
    id: "demo-casual-inbox",
    threadId: "thread-casual-dalton-11",
    subject: "friday?",
    from: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    to: "me@example.com",
    date: new Date(now - 2 * hour).toISOString(),
    body: `yo you free friday? was thinking we grab tacos at that new spot on valencia

dalton`,
    snippet: "yo you free friday? was thinking we grab tacos...",
  },

  // === STYLE TESTING: Formal contact (Dr. Geoff Ralston) ===
  // Inbox email from Dr. Ralston that needs a reply
  {
    id: "demo-formal-inbox",
    threadId: "thread-formal-geoff-11",
    subject: "Request for Strategic Advisory Input - FY2026 Planning",
    from: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    to: "me@example.com",
    date: new Date(now - 3 * hour).toISOString(),
    body: `Dear Colleague,

I hope this message finds you well. I am writing to request your input on several strategic matters pertaining to our FY2026 planning process.

Specifically, I would value your perspective on the following:

1. The proposed expansion of our technology advisory practice into the Asia-Pacific region
2. Resource allocation recommendations for the forthcoming investment cycle
3. Your assessment of emerging regulatory considerations that may impact our portfolio companies

I have attached a preliminary briefing document for your review. I would be most grateful if you could provide your analysis by the end of next week, as we are preparing materials for the Board of Directors meeting scheduled for March 15th.

Please do not hesitate to reach out if you require any additional context or supporting documentation.

With kind regards,
Dr. Geoff Ralston
Managing Partner
Whitfield & Partners`,
    snippet: "I am writing to request your input on several strategic matters...",
  },

  // Thread 7: Multi-sender thread (tests sidebar focused email switching)
  {
    id: "demo-multi-001",
    threadId: "thread-multi-sender",
    subject: "Launch Readiness Review - v2.0 Release",
    from: "Nicolas Dessaigne <nicolas.d@acmecorp.com>",
    to: "me@example.com, team@acmecorp.com",
    date: new Date(now - 3 * day).toISOString(),
    body: `Hi everyone,

I'd like to kick off the launch readiness review for v2.0. Here's what we need to finalize before the release:

1. Feature freeze is this Friday
2. QA sign-off needed by next Tuesday
3. Marketing materials should be ready by Wednesday

Can each of you confirm your area is on track?

Thanks,
Nicolas`,
    snippet: "I'd like to kick off the launch readiness review for v2.0...",
  },
  {
    id: "demo-multi-002",
    threadId: "thread-multi-sender",
    subject: "Re: Launch Readiness Review - v2.0 Release",
    from: "Pete Koomen <pete.koomen@acmecorp.com>",
    to: "me@example.com, nicolas.d@acmecorp.com, team@acmecorp.com",
    date: new Date(now - 2.8 * day).toISOString(),
    body: `Nicolas,

Backend is in good shape. All API endpoints are finalized and load-tested. One concern: the new search indexing needs another round of performance tuning before we can handle production traffic.

I'll have an update by Thursday.

Pete`,
    snippet: "Backend is in good shape. All API endpoints are finalized...",
  },
  {
    id: "demo-multi-003",
    threadId: "thread-multi-sender",
    subject: "Re: Launch Readiness Review - v2.0 Release",
    from: "Aaron Epstein <aaron.epstein@acmecorp.com>",
    to: "me@example.com, nicolas.d@acmecorp.com, team@acmecorp.com",
    date: new Date(now - 2.5 * day).toISOString(),
    body: `Team,

Design is ready. All screens have been finalized and handed off to engineering. The design system tokens are updated for the new color scheme.

One thing to flag: we still need final copy for the onboarding tooltips. @me - can you review the draft copy I sent last week?

Aaron`,
    snippet: "Design is ready. All screens have been finalized...",
  },
  {
    id: "demo-multi-004",
    threadId: "thread-multi-sender",
    subject: "Re: Launch Readiness Review - v2.0 Release",
    from: "Brad Flora <brad.flora@acmecorp.com>",
    to: "me@example.com, nicolas.d@acmecorp.com, team@acmecorp.com",
    date: new Date(now - 2 * day).toISOString(),
    body: `All,

QA is tracking 3 P1 bugs and 12 P2s. The P1s are all in the checkout flow - Pete, can you prioritize those?

Test coverage is at 87% which is above our 85% threshold. Automated regression suite passes on staging.

I'll share the full QA report tomorrow.

Brad`,
    snippet: "QA is tracking 3 P1 bugs and 12 P2s...",
  },
  {
    id: "demo-multi-005",
    threadId: "thread-multi-sender",
    subject: "Re: Launch Readiness Review - v2.0 Release",
    from: "Harj Taggar <harj.taggar@acmecorp.com>",
    to: "me@example.com, nicolas.d@acmecorp.com, team@acmecorp.com",
    date: new Date(now - 1.5 * day).toISOString(),
    body: `Hi all,

Marketing is almost there. Press release is drafted, social media campaign is scheduled, and the blog post is in final review.

We need the final release notes from engineering to complete the changelog page. @me - also wanted to confirm: are we doing the launch webinar on Thursday or Friday?

Best,
Harj`,
    snippet: "Marketing is almost there. Press release is drafted...",
  },
  {
    id: "demo-multi-006",
    threadId: "thread-multi-sender",
    subject: "Re: Launch Readiness Review - v2.0 Release",
    from: "Nicolas Dessaigne <nicolas.d@acmecorp.com>",
    to: "me@example.com, team@acmecorp.com",
    date: new Date(now - 6 * hour).toISOString(),
    body: `Team,

Thanks for the updates. Quick summary:
- Backend: on track, search perf needs work (Pete)
- Design: done, waiting on tooltip copy (Aaron)
- QA: 3 P1s to fix, overall good (Brad)
- Marketing: nearly ready, needs release notes (Harj)

@me - we need your input on the tooltip copy, release notes, and webinar date. Can you respond by EOD?

Nicolas`,
    snippet: "Thanks for the updates. We need your input on tooltip copy...",
  },

  // HTML formatted email (tests HTML rendering)
  {
    id: "demo-html-email",
    threadId: "thread-html-test",
    subject: "Weekly Product Update - New Features Launched!",
    from: "Product Team <product@acmecorp.com>",
    to: "me@example.com",
    date: new Date(now - 2 * hour).toISOString(),
    body: `<!DOCTYPE html>
<html>
<head>
  <style>
    .header { background-color: #4f46e5; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; font-family: Arial, sans-serif; }
    .feature { background-color: #f3f4f6; padding: 15px; margin: 10px 0; border-radius: 8px; }
    .cta-button { background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 Weekly Product Update</h1>
  </div>
  <div class="content">
    <p>Hi team,</p>
    <p>We're excited to share this week's product updates!</p>

    <div class="feature">
      <h3>✨ New Feature: Dark Mode</h3>
      <p>You can now switch to dark mode in your settings. Perfect for late-night coding sessions!</p>
    </div>

    <div class="feature">
      <h3>🔧 Bug Fixes</h3>
      <ul>
        <li>Fixed login timeout issues</li>
        <li>Improved dashboard loading speed by 40%</li>
        <li>Resolved email notification delays</li>
      </ul>
    </div>

    <div class="feature">
      <h3>📊 Coming Soon</h3>
      <p>Next week we'll be launching the new analytics dashboard. Stay tuned!</p>
    </div>

    <p style="margin-top: 20px;">
      <a href="https://example.com/changelog" class="cta-button">View Full Changelog</a>
    </p>

    <p style="color: #6b7280; font-size: 12px; margin-top: 30px;">
      You're receiving this because you're subscribed to product updates.<br>
      <a href="https://example.com/unsubscribe">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`,
    snippet: "We're excited to share this week's product updates! New Feature: Dark Mode...",
  },

  // EA scheduling thread — third party reaches out to schedule with user
  {
    id: "demo-ea-sched-001",
    threadId: "thread-ea-scheduling",
    subject: "Meeting to discuss partnership — finding a time",
    from: "David Lieb <david.lieb@partnerco.io>",
    to: "Ankit <ankit@example.com>",
    date: new Date(now - 2 * day - 4 * hour).toISOString(),
    body: `Hi Ankit,

Great chatting at the conference last week! I'd love to set up a 30-minute call to discuss the partnership opportunity we talked about.

Do you have any availability next week? Happy to work around your schedule.

Best,
David`,
    snippet: "Great chatting at the conference! I'd love to set up a 30-minute call...",
  },
  // User replies and CC's EA Claire
  {
    id: "demo-ea-sched-002",
    threadId: "thread-ea-scheduling",
    subject: "Re: Meeting to discuss partnership — finding a time",
    from: "Ankit <ankit@example.com>",
    to: "David Lieb <david.lieb@partnerco.io>",
    cc: "Claire <testea@ycombinator.com>",
    date: new Date(now - 2 * day - 3 * hour).toISOString(),
    body: `Hi David,

Great meeting you too! I'd be happy to chat.

I've CC'd Claire, my assistant, who can help coordinate scheduling. She has access to my calendar and will find a time that works.

Looking forward to it!

Best,
Ankit`,
    snippet: "I've CC'd Claire, my assistant, who can help coordinate scheduling...",
    labelIds: ["SENT"],
  },
  // EA Claire coordinates with David — user is CC'd
  {
    id: "demo-ea-sched-003",
    threadId: "thread-ea-scheduling",
    subject: "Re: Meeting to discuss partnership — finding a time",
    from: "Claire <testea@ycombinator.com>",
    to: "David Lieb <david.lieb@partnerco.io>",
    cc: "Ankit <ankit@example.com>",
    date: new Date(now - 2 * day - 2 * hour).toISOString(),
    body: `Hi David,

Thanks for your interest in connecting with Ankit! I'd be happy to help find a time.

Here are a few slots available next week:
- Tuesday 2:00–2:30 PM PT
- Wednesday 10:00–10:30 AM PT
- Thursday 3:00–3:30 PM PT

Would any of these work for you? If not, feel free to suggest alternatives and I'll check against Ankit's calendar.

Best,
Claire`,
    snippet: "Here are a few slots available next week: Tuesday 2:00–2:30 PM PT...",
  },
  // David replies to Claire — user still CC'd. This is the latest email user sees.
  {
    id: "demo-ea-sched-004",
    threadId: "thread-ea-scheduling",
    subject: "Re: Meeting to discuss partnership — finding a time",
    from: "David Lieb <david.lieb@partnerco.io>",
    to: "Claire <testea@ycombinator.com>",
    cc: "Ankit <ankit@example.com>",
    date: new Date(now - 1 * day - 5 * hour).toISOString(),
    body: `Hi Claire,

Wednesday at 10am PT works perfectly! Could we do it over Zoom?

Thanks for coordinating.

Best,
David`,
    snippet: "Wednesday at 10am PT works perfectly! Could we do it over Zoom?",
  },

  // Separate thread: user directly addressed despite EA being involved
  {
    id: "demo-ea-direct-001",
    threadId: "thread-ea-direct",
    subject: "Partnership technical requirements — need your input",
    from: "David Lieb <david.lieb@partnerco.io>",
    to: "Ankit <ankit@example.com>",
    cc: "Claire <testea@ycombinator.com>",
    date: new Date(now - 6 * hour).toISOString(),
    body: `Hi Ankit,

Before our meeting on Wednesday, I wanted to get your thoughts on a couple of technical questions:

1. What's your current API throughput? We need to understand capacity for the integration.
2. Do you support webhook callbacks, or would we need to poll?
3. Any security requirements we should be aware of (SOC2, etc)?

These will help me prepare the right materials for our discussion.

Thanks,
David`,
    snippet: "Before our meeting, I wanted to get your thoughts on technical questions...",
  },

  // Intro request — YC partner asking for 5 intros to other YC people
  {
    id: "demo-intro-request",
    threadId: "thread-intro-request",
    subject: "Can you intro me to a few folks?",
    from: "Gustaf Alströmer <gustaf.a@startup.io>",
    to: "Ankit <ankit@example.com>",
    date: new Date(now - 1.5 * hour).toISOString(),
    body: `Hey Ankit,

Hope you're doing well! I'm working on a growth-focused AI project and I'd love to get connected with a few people in your network who I think could be really helpful.

Could you intro me to:

1. Garry Tan — I'd love to get his perspective on the market landscape and how he's thinking about AI-native products
2. Jared Friedman — heard he's been diving deep into developer tools, and I have some ideas I'd love to bounce off him
3. Diana Hu — she has incredible insight into the technical side of scaling AI systems

No rush on all three at once — happy to take them one at a time if that's easier. And of course, only if you think each one makes sense.

Thanks so much!

Gustaf`,
    snippet: "Could you intro me to Garry, Jared, and Diana?",
  },

  // Introduction email — someone connecting two people
  {
    id: "demo-intro",
    threadId: "thread-intro",
    subject: "Intro: Ankit <> Tim Brady (AI infrastructure)",
    from: "Kevin Hale <kevin.hale@venturefirm.com>",
    to: "Ankit <ankit@example.com>, Tim Brady <tim.brady@aistack.dev>",
    date: new Date(now - 3 * hour).toISOString(),
    body: `Hi Ankit and Tim,

I wanted to connect the two of you! I think there could be a great fit here.

Ankit — Tim is the CTO at AIStack and is building some really impressive infrastructure for serving large language models at scale. He's looking for design partners who are building AI-powered products.

Tim — Ankit is building a next-gen email client with deep AI integration. He's exactly the kind of builder who would benefit from your platform, and could give you valuable feedback on the developer experience.

I'll let the two of you take it from here!

Best,
Kevin`,
    snippet: "I wanted to connect the two of you! I think there could be a great fit here...",
  },
];

// Expected analysis results for demo emails
export const DEMO_EXPECTED_ANALYSIS: Record<string, { needsReply: boolean; priority?: "high" | "medium" | "low"; reason: string }> = {
  "demo-001": { needsReply: false, reason: "Initial email in thread, already has follow-ups" },
  "demo-002": { needsReply: false, reason: "Middle of thread, not the latest message" },
  "demo-003": { needsReply: true, priority: "high", reason: "Direct question about availability and request for technical input" },
  "demo-004": { needsReply: true, priority: "medium", reason: "Technical questions requiring expertise, customer going live next week" },
  "demo-005": { needsReply: true, priority: "high", reason: "Action items with deadline, needs confirmation for exec review" },
  "demo-006": { needsReply: false, reason: "Automated GitHub CI notification" },
  "demo-007": { needsReply: false, reason: "Newsletter/marketing email" },
  "demo-008": { needsReply: false, reason: "Automated shipping notification" },
  "demo-009": { needsReply: true, priority: "medium", reason: "Interview scheduling request requiring confirmation" },
  "demo-010": { needsReply: true, priority: "low", reason: "Personal lunch invitation, can respond when convenient" },
  "demo-011": { needsReply: false, reason: "Automated calendar notification" },
  "demo-012": { needsReply: true, priority: "high", reason: "Production incident requiring immediate attention" },
  "demo-meeting": { needsReply: true, priority: "medium", reason: "Partnership discussion request with scheduling ask" },
  "demo-inline-images": { needsReply: true, priority: "medium", reason: "Design review request requiring feedback" },
  "demo-sent-reply-001": { needsReply: false, reason: "Sent by user - no reply needed" },
  "demo-multi-001": { needsReply: false, reason: "Initial kickoff email, already has follow-ups" },
  "demo-multi-002": { needsReply: false, reason: "Status update from Pete, not directly addressed to user" },
  "demo-multi-003": { needsReply: false, reason: "Status update from Aaron, copy review request addressed in later email" },
  "demo-multi-004": { needsReply: false, reason: "QA status update from Brad" },
  "demo-multi-005": { needsReply: false, reason: "Marketing status, webinar question addressed in later email" },
  "demo-multi-006": { needsReply: true, priority: "high", reason: "Direct request for tooltip copy, release notes, and webinar date by EOD" },
  "demo-html-email": { needsReply: false, reason: "Product update newsletter, no action required" },
  "demo-casual-inbox": { needsReply: true, priority: "low", reason: "Casual friend asking about weekend plans" },
  "demo-formal-inbox": { needsReply: true, priority: "medium", reason: "Strategic advisory request with deadline from managing partner" },
  "demo-intro-request": { needsReply: true, priority: "high", reason: "Direct request for 3 introductions — requires drafting individual intro emails to Garry, Jared, and Diana" },
  "demo-intro": { needsReply: true, priority: "high", reason: "Introduction email — should reply to Tim and BCC Kevin (the introducer) to move him to BCC" },
  "demo-ea-sched-001": { needsReply: false, reason: "Initial scheduling request, already replied in thread" },
  "demo-ea-sched-002": { needsReply: false, reason: "Sent by user — no reply needed" },
  "demo-ea-sched-003": { needsReply: false, reason: "Sent by EA Claire coordinating scheduling — no user action needed" },
  "demo-ea-sched-004": { needsReply: true, priority: "medium", reason: "David confirmed a time — but Claire (EA) is handling scheduling, user is just CC'd" },
  "demo-ea-direct-001": { needsReply: true, priority: "high", reason: "Direct technical questions addressed to user requiring personal expertise" },
};

// Demo sent emails for style learning
export const DEMO_SENT_EMAILS: SentEmail[] = [
  {
    id: "sent-demo-001",
    toAddress: "jared.friedman@acmecorp.com",
    subject: "Re: Project Alpha - Initial thoughts",
    body: `Jared,

Thanks for putting this together. A few thoughts:

1. Timeline looks good, though I agree with adding buffer
2. I can handle the architecture doc
3. Let's sync on the technical risks early

Happy to discuss further.`,
    date: new Date(now - 7 * day).toISOString(),
  },
  {
    id: "sent-demo-002",
    toAddress: "gustaf.a@startup.io",
    subject: "Re: API Integration Help",
    body: `Hey Gustaf,

Good questions! Here's what I'd recommend:

1. For rate limits, you can request an increase through our developer portal
2. Exponential backoff is the way to go - we have a code sample in our docs
3. Check out our /batch endpoint - it handles up to 100 items per request

Let me know if you run into any other issues.

Best,`,
    date: new Date(now - 10 * day).toISOString(),
  },
  {
    id: "sent-demo-003",
    toAddress: "d.hu@techcorp.com",
    subject: "Re: Q3 Review",
    body: `Diana,

Thanks for the summary. I reviewed the numbers and have a few comments:

- Revenue projections look achievable given current trajectory
- I'd suggest we revisit the hiring timeline
- Happy to present the technical roadmap section

Let's connect tomorrow to finalize.

Thanks,`,
    date: new Date(now - 14 * day).toISOString(),
  },
];

// Mock draft responses for demo mode
export const DEMO_DRAFT_RESPONSES: Record<string, string> = {
  "demo-003": `Hi Jared,

Monday at 10am PT works for me. I'll have my calendar blocked.

For the technical architecture, I can prepare a brief overview of the key decisions we need to make:
- Database schema design
- API structure
- Authentication approach

I'll share a doc before the meeting so we can hit the ground running.

See you Monday!`,

  "demo-004": `Hey Gustaf,

Happy to help! Here are answers to your questions:

1. **Rate limit increase**: You can request a higher limit through our developer portal at developers.example.com/rate-limits. For production use cases, we typically approve 1000 req/min.

2. **Backoff strategy**: Yes, exponential backoff is recommended. Start with 1 second delay, double each retry, max 5 retries.

3. **Batch endpoints**: Check out POST /v2/batch - it handles up to 100 operations per request and doesn't count against your rate limit the same way.

Let me know if you need anything else before your launch!`,

  "demo-005": `Hi Diana,

Thanks for capturing these. Quick responses:

1. Budget proposal - I'll review and send comments by EOD Wednesday
2. Headcount - I'm thinking 2 senior engineers + 1 PM, will detail in a separate doc
3. Technical feasibility - Confirmed, the timeline is achievable with the proposed scope

Tomorrow works for a sync - how about 2pm?`,

  "demo-009": `Hi,

I can do the Wednesday 10am-11am slot.

Yes, please send over Jordan's resume - I'd like to review their system design experience beforehand.

For the interview, I'll focus on:
- Distributed systems concepts
- API design principles
- A practical coding exercise

Thanks!`,

  "demo-010": `Hey Tom!

Lunch sounds great - I'm free Friday. The ramen place sounds perfect.

Want to meet there around 12:30?`,

  "demo-012": `Joining the incident channel now.

Quick context: The payment timeout issue might be related to the third-party payment processor. I saw similar symptoms last month when they had latency issues.

First steps I'd recommend:
1. Check our payment provider's status page
2. Look at p99 latency on the payment service
3. Consider enabling the fallback provider if this persists

Hopping on Zoom now.`,

  "demo-meeting": `Hi Kat,

Thanks for reaching out! I'd be happy to discuss partnership opportunities with PartnerCo.

I've copied my assistant who can help coordinate scheduling. They have access to my calendar and will find a time that works for everyone.

Looking forward to the conversation!`,

  "demo-intro-request": `yup i'm on it`,

  "demo-intro": `Hi Tim,

Great to e-meet you! Kevin has told me great things about what you're building at AIStack.

I'm indeed building an AI-powered email client and we're doing a lot of LLM inference — both for email analysis and draft generation. Would love to learn more about your infrastructure and how it might help us scale.

Are you free for a 30-minute call sometime next week? Happy to work around your schedule.

Best,
Ankit`,

  "demo-ea-direct-001": `Hi David,

Great questions — here's a quick rundown:

1. **API throughput**: We're currently handling ~500 req/s on our production tier, with burst capacity up to 2k req/s.
2. **Webhooks**: Yes, we support webhook callbacks for all major events. I'll share the docs ahead of our call.
3. **Security**: We're SOC2 Type II certified and can provide our security questionnaire if needed.

Happy to dive deeper on Wednesday.

Best,
Ankit`,
};

// Sent emails seeded into DB for style profiling (not shown in inbox)
export const DEMO_STYLE_SEED_EMAILS: Email[] = [
  // 10 casual sent emails to Dalton — all lowercase, ~10 words, minimal punctuation
  {
    id: "demo-sent-casual-01",
    threadId: "thread-casual-dalton-01",
    subject: "Re: weekend",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 3 * day).toISOString(),
    body: "yeah sounds good lets do saturday",
    snippet: "yeah sounds good lets do saturday",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-02",
    threadId: "thread-casual-dalton-02",
    subject: "Re: that new show",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 5 * day).toISOString(),
    body: "haha nice ill check it out tonight",
    snippet: "haha nice ill check it out tonight",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-03",
    threadId: "thread-casual-dalton-03",
    subject: "Re: dinner tonight",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 8 * day).toISOString(),
    body: "hey running late be there in 10",
    snippet: "hey running late be there in 10",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-04",
    threadId: "thread-casual-dalton-04",
    subject: "Re: extra ticket",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 12 * day).toISOString(),
    body: "nah im good thanks tho",
    snippet: "nah im good thanks tho",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-05",
    threadId: "thread-casual-dalton-05",
    subject: "Re: last night",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 15 * day).toISOString(),
    body: "lol yeah that was wild",
    snippet: "lol yeah that was wild",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-06",
    threadId: "thread-casual-dalton-06",
    subject: "Re: meetup",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 20 * day).toISOString(),
    body: "cool cool see you there",
    snippet: "cool cool see you there",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-07",
    threadId: "thread-casual-dalton-07",
    subject: "Re: article",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 25 * day).toISOString(),
    body: "hey can you send me that link again",
    snippet: "hey can you send me that link again",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-08",
    threadId: "thread-casual-dalton-08",
    subject: "Re: yo",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 30 * day).toISOString(),
    body: "yeah just got home whats up",
    snippet: "yeah just got home whats up",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-09",
    threadId: "thread-casual-dalton-09",
    subject: "Re: bbq",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 38 * day).toISOString(),
    body: "nice one ill bring the stuff tomorrow",
    snippet: "nice one ill bring the stuff tomorrow",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-casual-10",
    threadId: "thread-casual-dalton-10",
    subject: "Re: road trip idea",
    from: "me@example.com",
    to: "Dalton Caldwell <dalton.caldwell@gmail.com>",
    date: new Date(now - 45 * day).toISOString(),
    body: "haha for real tho we should do that",
    snippet: "haha for real tho we should do that",
    labelIds: ["SENT"],
  },

  // 10 formal sent emails to Dr. Geoff Ralston — proper capitalization, structured, "Dear/Regards"
  {
    id: "demo-sent-formal-01",
    threadId: "thread-formal-geoff-01",
    subject: "Re: Q4 Strategic Review - Preliminary Analysis",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 4 * day).toISOString(),
    body: `Dear Dr. Ralston,

Thank you for sharing the preliminary analysis. I have reviewed the documentation thoroughly and would like to offer the following observations:

1. The projected growth figures for Q4 appear well-substantiated by the market data presented
2. I would recommend we revisit the risk mitigation strategy outlined in Section 3, particularly regarding currency exposure
3. The timeline for implementation seems achievable, though I suggest we build in additional review cycles

I would be happy to schedule a meeting at your earliest convenience to discuss these points in greater detail.

Best regards`,
    snippet: "Thank you for sharing the preliminary analysis...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-02",
    threadId: "thread-formal-geoff-02",
    subject: "Re: Board Meeting Preparation - Agenda Review",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 9 * day).toISOString(),
    body: `Dear Geoff,

Thank you for circulating the proposed agenda for the upcoming board meeting. I have reviewed each item carefully and have the following recommendations:

1. I believe the technology roadmap presentation should be moved earlier in the agenda, as it provides context for the budget discussion
2. The compliance update section could benefit from a brief overview of recent regulatory developments
3. I would suggest allocating an additional fifteen minutes to the strategic partnerships discussion

Please let me know if you would like to discuss any of these suggestions before finalizing the agenda.

Regards`,
    snippet: "Thank you for circulating the proposed agenda...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-03",
    threadId: "thread-formal-geoff-03",
    subject: "Re: Due Diligence Report - Confidential",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 14 * day).toISOString(),
    body: `Dear Dr. Ralston,

I appreciate you sharing the due diligence findings. After a thorough review of the materials, I would like to highlight several areas that warrant further examination:

1. The intellectual property portfolio appears strong, though I recommend independent verification of the three pending patents
2. The financial projections in the management presentation appear optimistic relative to industry benchmarks
3. The customer concentration risk should be carefully evaluated, as the top three clients represent over sixty percent of revenue

I am available to discuss these findings at your convenience. I would also recommend we engage external counsel to review the IP matters prior to proceeding.

Best regards`,
    snippet: "I appreciate you sharing the due diligence findings...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-04",
    threadId: "thread-formal-geoff-04",
    subject: "Re: Partnership Framework Discussion",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 18 * day).toISOString(),
    body: `Dear Geoff,

Thank you for the productive discussion regarding the partnership framework. I wanted to follow up with a summary of the key points we agreed upon:

1. The governance structure will follow a joint committee model with equal representation
2. Financial commitments will be reviewed on a quarterly basis with defined escalation procedures
3. Intellectual property developed during the partnership will be jointly owned, subject to pre-existing IP carve-outs

I will have my team prepare a detailed term sheet reflecting these principles for your review by end of week.

Best regards`,
    snippet: "Thank you for the productive discussion...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-05",
    threadId: "thread-formal-geoff-05",
    subject: "Re: Annual Compliance Review",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 22 * day).toISOString(),
    body: `Dear Dr. Ralston,

Thank you for initiating the annual compliance review process. I have completed my assessment of the areas under my purview and would like to report the following:

1. All mandatory training requirements have been fulfilled across the team
2. Data handling procedures have been updated to reflect the latest regulatory guidance
3. I have identified two areas where our current policies would benefit from revision, which I have detailed in the attached memorandum

I am confident that we remain in full compliance with all applicable regulations. Please do not hesitate to contact me should you require any additional information.

Regards`,
    snippet: "Thank you for initiating the annual compliance review...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-06",
    threadId: "thread-formal-geoff-06",
    subject: "Re: Investment Committee Briefing Materials",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 28 * day).toISOString(),
    body: `Dear Geoff,

I have reviewed the investment committee briefing materials and prepared my analysis of the three proposed opportunities:

1. The Series B opportunity in the enterprise software space presents an attractive risk-adjusted return profile
2. The infrastructure fund allocation merits further discussion, particularly regarding the illiquidity premium assumptions
3. I recommend we defer consideration of the emerging markets vehicle until we have completed our geographic exposure analysis

I will be prepared to present these findings at Thursday's committee meeting.

Best regards`,
    snippet: "I have reviewed the investment committee briefing materials...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-07",
    threadId: "thread-formal-geoff-07",
    subject: "Re: Governance Policy Updates",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 33 * day).toISOString(),
    body: `Dear Dr. Ralston,

Thank you for sharing the proposed governance policy updates. I have reviewed the revisions carefully and offer the following feedback:

1. The enhanced disclosure requirements are well-aligned with current best practices
2. I would suggest strengthening the conflict of interest provisions in Section 4.2
3. The board composition guidelines should reference the diversity commitments we made in our annual report

These are otherwise comprehensive and well-drafted revisions. I am supportive of their adoption at the next board meeting.

Regards`,
    snippet: "Thank you for sharing the proposed governance policy updates...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-08",
    threadId: "thread-formal-geoff-08",
    subject: "Re: Risk Assessment Findings",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 40 * day).toISOString(),
    body: `Dear Geoff,

I have completed my review of the risk assessment findings and concur with the overall conclusions. I would like to add the following observations:

1. The operational risk category should incorporate scenarios related to supply chain disruption
2. The cybersecurity risk rating may need to be elevated given recent industry developments
3. I recommend we establish a quarterly risk review cadence to ensure our assessments remain current

I am available to discuss these observations at your earliest convenience and can provide supporting documentation as needed.

Best regards`,
    snippet: "I have completed my review of the risk assessment findings...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-09",
    threadId: "thread-formal-geoff-09",
    subject: "Re: Quarterly Stakeholder Report",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 48 * day).toISOString(),
    body: `Dear Dr. Ralston,

Thank you for the opportunity to contribute to the quarterly stakeholder report. Please find below my section on technology and innovation developments:

1. Our digital transformation initiative is proceeding ahead of schedule, with three of five workstreams now complete
2. The new analytics platform has been successfully deployed and is generating measurable improvements in decision-making efficiency
3. We anticipate completing the remaining technology modernization milestones by the end of Q2

I trust this information is sufficient for the report. Please let me know if any additional detail would be helpful.

Regards`,
    snippet: "Thank you for the opportunity to contribute to the quarterly stakeholder report...",
    labelIds: ["SENT"],
  },
  {
    id: "demo-sent-formal-10",
    threadId: "thread-formal-geoff-10",
    subject: "Re: Strategic Advisory Engagement Proposal",
    from: "me@example.com",
    to: "Dr. Geoff Ralston <g.ralston@whitfield-partners.com>",
    date: new Date(now - 55 * day).toISOString(),
    body: `Dear Geoff,

I have reviewed the strategic advisory engagement proposal with great interest. The scope of work is well-defined and the proposed methodology is sound. I would like to offer several suggestions:

1. The discovery phase would benefit from inclusion of key operational stakeholders in addition to the executive team
2. I recommend incorporating a competitive landscape analysis as a distinct workstream
3. The proposed fee structure is reasonable and consistent with market benchmarks for engagements of this nature

I am supportive of proceeding and would be pleased to serve on the steering committee as proposed.

Best regards`,
    snippet: "I have reviewed the strategic advisory engagement proposal...",
    labelIds: ["SENT"],
  },
];
