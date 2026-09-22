# Vendored fonts

Poppins and Inter, both **SIL Open Font License 1.1**, which explicitly permits
redistribution. `POPPINS-OFL.txt` and `INTER-OFL.txt` are their licences and must stay
alongside them — the OFL requires the notice to travel with the files.

These are the site's own typefaces: `views/header.ejs` loads both from Google Fonts and
`static/css/modern-styles.css` uses Poppins for headings. Before this, the social images
were drawn in Arial bitmaps, so every picture the league posted was in a typeface the
website does not use.

## Only Regular and Bold, deliberately

A SemiBold static instance reports its family as **"Poppins SemiBold"**, not as weight 600
of "Poppins" — checked against the name table of the actual files, 22 Sep 2026. So
`font-family="Poppins" font-weight="600"` does **not** select it: fontconfig sees a
different family entirely and falls back, usually by synthesising a fake bold from
Regular, which looks subtly wrong and reports no error.

Regular and Bold report family "Poppins"/"Inter" with subfamilies "Regular"/"Bold", so
`font-weight: normal | bold` resolves correctly. Two real weights per family is plenty for
these cards. **If you add a weight, read its name table first** — do not assume the file
name tells you what fontconfig will call it.

## Do not add Arial back

`fonts/Arial.ttf` was Monotype's Arial, "Copyright (c) 1997 Microsoft Corp". It is
proprietary and was never licensed for redistribution in a container image. It has been
removed.
