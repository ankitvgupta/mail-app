import type { Email, SentEmail } from "../../src/shared/types";

// HTML email bodies for testing reply/forward quoting
export const HTML_EMAIL_BODIES = {
  simple: `<div>Hello,</div><div><br></div><div>This is a simple test email.</div><div><br></div><div>Best,</div><div>John</div>`,

  withStyles: `<div style="font-family: Arial, sans-serif; color: #333;">
    <p style="margin-bottom: 16px;">Hi there,</p>
    <p style="color: blue;">This text is <strong>bold</strong> and <em>italic</em>.</p>
    <ul style="margin-left: 20px;">
      <li>List item 1</li>
      <li>List item 2</li>
    </ul>
  </div>`,

  withImage: `<div>Check out this image:</div>
    <img src="https://example.com/image.png" alt="Test image" style="max-width: 100%;">
    <div>Pretty cool, right?</div>`,

  fullGmailFormat: `<html><head><meta charset="utf-8"></head><body>
    <div dir="ltr">
      <div>Hi there,</div>
      <div><br></div>
      <div>I wanted to follow up on our conversation from last week.</div>
      <div><br></div>
      <div>Could you please review the attached document and let me know your thoughts?</div>
      <div><br></div>
      <div>Best regards,</div>
      <div>Sarah</div>
    </div>
  </body></html>`,
};

// Fake inbox emails for testing
export const FAKE_INBOX_EMAILS: Email[] = [
  {
    id: "msg-001",
    threadId: "thread-001",
    subject: "Project Status Update Request",
    from: "Sarah Johnson <sarah.johnson@example.com>",
    to: "me@example.com",
    date: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
    body: HTML_EMAIL_BODIES.fullGmailFormat, // Use HTML body for testing
    snippet: "I wanted to check in on the project we discussed last week...",
  },
  {
    id: "msg-002",
    threadId: "thread-002",
    subject: "Meeting Follow-up: Q4 Planning",
    from: "Michael Chen <m.chen@techcorp.com>",
    to: "me@example.com",
    date: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
    body: `Hello,

Great discussion in today's Q4 planning meeting! I have a few follow-up items that need your input:

1. Budget allocation for the new initiative - can you review the attached spreadsheet and let me know your thoughts?
2. Team assignments - we need to finalize who will lead each workstream
3. Key milestones - please confirm the dates work for your team

Can we schedule a quick call tomorrow to finalize these items?

Best,
Michael`,
    snippet: "Great discussion in today's Q4 planning meeting...",
  },
  {
    id: "msg-003",
    threadId: "thread-003",
    subject: "GitHub Actions workflow failed",
    from: "noreply@github.com",
    to: "me@example.com",
    date: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4 hours ago
    body: `The workflow "CI" in repository "myorg/myrepo" has failed.

Commit: abc123
Message: Fix typo in documentation
Author: developer@example.com

View the workflow run for more details:
https://github.com/myorg/myrepo/actions/runs/12345

---
GitHub Actions`,
    snippet: "The workflow CI in repository myorg/myrepo has failed...",
  },
  {
    id: "msg-004",
    threadId: "thread-004",
    subject: "Weekly Newsletter: Tech Industry Updates",
    from: "Tech Weekly <newsletter@techweekly.com>",
    to: "me@example.com",
    date: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6 hours ago
    body: `TECH WEEKLY NEWSLETTER

Top Stories This Week:
- AI breakthrough in natural language processing
- New smartphone releases shake up the market
- Cloud computing trends to watch in 2024

Read more at techweekly.com

To unsubscribe, click here: https://techweekly.com/unsubscribe`,
    snippet: "TECH WEEKLY NEWSLETTER - Top Stories This Week...",
  },
  {
    id: "msg-005",
    threadId: "thread-005",
    subject: "Quick question about API integration",
    from: "Alex Rodriguez <alex.r@startup.io>",
    to: "me@example.com",
    date: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), // 8 hours ago
    body: `Hey!

Quick question - we're integrating with your API and running into some rate limiting issues. What's the best way to handle this for batch operations?

We're seeing 429 errors when we try to make more than 100 requests per minute. Is there a way to increase our limit, or should we implement exponential backoff?

Thanks for any guidance!

Alex`,
    snippet: "Quick question - we're integrating with your API...",
  },
  {
    id: "msg-006",
    threadId: "thread-006",
    subject: "Your Amazon.com order has shipped",
    from: "ship-confirm@amazon.com",
    to: "me@example.com",
    date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12 hours ago
    body: `Your Amazon.com order #123-4567890-1234567 has shipped!

Estimated delivery: Friday, January 24

Track your package: https://amazon.com/track/...

Items in this shipment:
- USB-C Cable (2-pack)
- Wireless Mouse

Thank you for shopping with Amazon.`,
    snippet: "Your Amazon.com order has shipped...",
  },
];

// Fake sent emails for style learning
export const FAKE_SENT_EMAILS: SentEmail[] = [
  {
    id: "sent-001",
    toAddress: "sarah.johnson@example.com",
    subject: "Re: Project Status Update Request",
    body: `Hi Sarah,

Thanks for reaching out. Here's a quick update:

1. We're about 80% complete on the main deliverables
2. No major blockers, but we did encounter some minor API issues that we've since resolved
3. Timeline is still on track for the original deadline

Happy to jump on a call if you need more details.

Best,`,
    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
  },
  {
    id: "sent-002",
    toAddress: "m.chen@techcorp.com",
    subject: "Re: Budget Review",
    body: `Michael,

I've reviewed the budget proposal and have a few thoughts:

- The infrastructure costs look reasonable
- I'd suggest increasing the contingency buffer to 15%
- Let me know if you need additional justification for the headcount request

Let's discuss tomorrow.

Thanks,`,
    date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
  },
  {
    id: "sent-003",
    toAddress: "alex.r@startup.io",
    subject: "Re: Partnership Proposal",
    body: `Hey Alex,

Great to hear from you! The partnership sounds interesting.

I'd be happy to set up an intro call with our team. How does next Tuesday work for you? We could do 2pm PT.

Looking forward to exploring this further.

Cheers,`,
    date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days ago
  },
];

// Expected analysis results for testing
export const EXPECTED_ANALYSIS = {
  "msg-001": { needsReply: true }, // Direct request for status update
  "msg-002": { needsReply: true }, // Follow-up items needing input
  "msg-003": { needsReply: false }, // Automated GitHub notification
  "msg-004": { needsReply: false }, // Newsletter
  "msg-005": { needsReply: true }, // Technical question
  "msg-006": { needsReply: false }, // Shipping notification
};
