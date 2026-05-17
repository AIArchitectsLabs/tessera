Produce a JSON-shaped activity snapshot for {{inputs.scope}}. Use workspace file, mail, drive, or calendar context when available.

Return only one JSON object with these keys:
- openItems: integer count
- atRisk: integer count
- highlights: array of short strings
- summary: short paragraph

If selected workspace sources are unavailable or no activity is found, use 0 for counts, but do not leave highlights or summary blank. Add one highlight that says no source activity was available for the selected scope, and make the summary explain what was unavailable and that there are no detected follow-ups yet.
