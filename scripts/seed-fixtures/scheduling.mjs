/**
 * Scheduling threads: multi-message conversations about meeting times.
 * The calendaring-agent eval suite should detect these as scheduling.
 *
 * Threading is wired via Message-IDs that the seed script substitutes
 * `<id>@test-inbox.local` into. The `inReplyTo` field references the
 * id of the parent fixture; the script resolves to a real Message-ID at
 * insert time.
 *
 * @type {import("./types.mjs").SeedFixture[]}
 */
export const scheduling = [
  // Thread 1: 3-message exchange about a customer meeting
  {
    id: "sched-t1-1",
    from: "Frank Lopez <frank@bigcustomer.test>",
    subject: "Touching base — quick call next week?",
    body: [
      "Hey,",
      "",
      "Hope you're doing well. Could we grab 30 minutes next week to catch up on the integration work?",
      "Tuesday or Wednesday afternoon would be great on my end.",
      "",
      "Frank",
    ].join("\n"),
  },
  {
    id: "sched-t1-2",
    from: "Frank Lopez <frank@bigcustomer.test>",
    subject: "Re: Touching base — quick call next week?",
    body: [
      "Just nudging this — does Tue 2pm or Wed 3pm work?",
      "",
      "Frank",
    ].join("\n"),
    inReplyTo: "sched-t1-1",
    references: ["sched-t1-1"],
  },
  {
    id: "sched-t1-3",
    from: "Frank Lopez <frank@bigcustomer.test>",
    subject: "Re: Touching base — quick call next week?",
    body: [
      "If easier I can also do EOD Friday this week. Otherwise let's lock in next week.",
      "",
      "Frank",
    ].join("\n"),
    inReplyTo: "sched-t1-2",
    references: ["sched-t1-1", "sched-t1-2"],
  },

  // Thread 2: scheduling between three parties
  {
    id: "sched-t2-1",
    from: "Grace Kim <grace.kim@partner.test>",
    subject: "Quarterly sync — picking a time",
    body: [
      "Hi,",
      "",
      "Time for our quarterly sync. I have Helen and James from our side; sounds like a 60-min slot",
      "with all of us would be ideal. Any of these work for you?",
      "",
      "- Mon 10am",
      "- Tue 4pm",
      "- Thu 11am",
      "",
      "Grace",
    ].join("\n"),
  },
  {
    id: "sched-t2-2",
    from: "Grace Kim <grace.kim@partner.test>",
    subject: "Re: Quarterly sync — picking a time",
    body: [
      "Just adding: we can also do Friday 2pm if none of those work.",
      "",
      "Grace",
    ].join("\n"),
    inReplyTo: "sched-t2-1",
    references: ["sched-t2-1"],
  },

  // Standalone scheduling note (no thread)
  {
    id: "sched-3-calendar-invite",
    from: "Helen Martinez <helen@vendor.test>",
    subject: "Calendar invite: contract review",
    body: [
      "Sending a calendar invite for the contract review at 3pm on Thursday.",
      "30 minutes, video link in the invite. Let me know if the time doesn't work.",
      "",
      "Helen",
    ].join("\n"),
  },
];
