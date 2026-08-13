/**
 * Newsletters and promo: low-signal, no-reply expected.
 * The analyzer eval suite should mark these as needs_reply=false.
 *
 * @type {import("./types.mjs").SeedFixture[]}
 */
export const newsletters = [
  {
    id: "nl-1-stratechery-weekly",
    from: "Ben Thompson <ben@example-newsletter.test>",
    subject: "Stratechery Weekly: Platform Economics",
    body: `<html><body>
<h2>Stratechery Weekly</h2>
<p>This week I take a look at how aggregator dynamics shape the choices of new platform entrants...</p>
<p><a href="https://example.test/article">Read the full post →</a></p>
<hr>
<p style="color:#888;font-size:11px">You're receiving this because you subscribed at stratechery.example.test. <a href="https://example.test/unsubscribe">Unsubscribe</a>.</p>
</body></html>`,
    html: true,
  },
  {
    id: "nl-2-hn-digest",
    from: "Hacker News Daily <digest@hn.example.test>",
    subject: "Top 10 stories on Hacker News today",
    body: `<html><body>
<h3>Today's top stories</h3>
<ol>
<li><a href="https://example.test/1">Show HN: I built a thing in Rust (218 points)</a></li>
<li><a href="https://example.test/2">Ask HN: How do you handle X? (164 points)</a></li>
<li><a href="https://example.test/3">The future of distributed systems (132 points)</a></li>
</ol>
<p style="color:#888"><a href="https://example.test/unsubscribe">unsubscribe</a></p>
</body></html>`,
    html: true,
  },
  {
    id: "nl-3-product-update",
    from: "Tools Inc. <updates@tools-inc.test>",
    subject: "What's new in Tools — November release",
    body: `<html><body>
<h2>November release notes</h2>
<ul>
<li>New: bulk import from CSV</li>
<li>Improved: search now 3x faster</li>
<li>Fixed: the dropdown bug on Safari</li>
</ul>
<p><a href="https://example.test/changelog">Full changelog</a></p>
</body></html>`,
    html: true,
  },
  {
    id: "nl-4-promo-sale",
    from: "ShopCo Marketing <promo@shopco.test>",
    subject: "🎉 Black Friday: 30% off everything",
    body: `<html><body>
<h1 style="color:red">30% OFF EVERYTHING</h1>
<p>Code: <b>FRIDAY30</b></p>
<p>Limited time only. Shop now.</p>
<p style="color:#888;font-size:11px"><a href="https://example.test/unsubscribe">unsubscribe</a></p>
</body></html>`,
    html: true,
  },
  {
    id: "nl-5-conference-cfp",
    from: "ConfBoston <cfp@confboston.test>",
    subject: "ConfBoston 2026 — CFP closes Friday",
    body: [
      "Reminder: the call for proposals for ConfBoston 2026 closes this Friday at 11:59 PM ET.",
      "",
      "Submit at https://example.test/cfp",
      "",
      "— ConfBoston organizers",
    ].join("\n"),
  },
];
