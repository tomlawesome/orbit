#!/usr/bin/env bash
# Fetch the typefaces the extraction corpus renders with.
#
# These are BUILD-TIME TOOLING for generating test fixtures. They are not
# product assets: nothing here is shipped in the Orbit image, served to a
# user, or redistributed. Regenerating the corpus needs them; running Orbit
# does not.
#
# Only ten fonts are installed on this host (see AGENTS.md), and real
# household paper is not printed in ten faces. Every provider uses its own,
# and the typeface decides the PDF's character map -- which is where
# extraction faults like the \& escape in #982 actually come from.
#
# The files are deliberately NOT committed. Fetching them here keeps the
# project from redistributing a copy and the licence obligations that go with
# that; the corpus text itself is committed, so this is only needed to
# regenerate the fixtures.
set -euo pipefail
cd "$(dirname "$0")/fonts"

base="https://raw.githubusercontent.com/google/fonts/main"

# family-dir  file  licence
fonts=(
  "ofl/ptsans|PT_Sans-Web-Regular.ttf|OFL-1.1"
  "ofl/ptsans|PT_Sans-Web-Bold.ttf|OFL-1.1"
  "ofl/ptmono|PTM55FT.ttf|OFL-1.1"
  "ofl/sourceserif4|SourceSerif4%5Bopsz,wght%5D.ttf|OFL-1.1"
  "ofl/courierprime|CourierPrime-Regular.ttf|OFL-1.1"
  "ofl/courierprime|CourierPrime-Bold.ttf|OFL-1.1"
  "ofl/archivonarrow|ArchivoNarrow%5Bwght%5D.ttf|OFL-1.1"
  "ofl/ebgaramond|EBGaramond%5Bwght%5D.ttf|OFL-1.1"
  "ofl/ebgaramond|EBGaramond-Italic%5Bwght%5D.ttf|OFL-1.1"
  "ofl/nunito|Nunito%5Bwght%5D.ttf|OFL-1.1"
  "ofl/spacegrotesk|SpaceGrotesk%5Bwght%5D.ttf|OFL-1.1"
)

: > LICENCES.txt
{
  echo "Typefaces used to render the extraction corpus."
  echo "Build-time tooling only -- not shipped in the Orbit image."
  echo
} >> LICENCES.txt

for entry in "${fonts[@]}"; do
  IFS='|' read -r dir file licence <<< "$entry"
  raw="$(printf '%b' "${file//%/\\x}")"
  # Google ships variable fonts as "Name[wght].ttf". Brackets do not resolve
  # in a CSS url(), so the axis tag is dropped locally.
  out="$(printf '%s' "$raw" | sed 's/\[[^]]*\]//')"
  if [ ! -f "$out" ]; then
    curl -sSLf --max-time 60 -o "$out" "$base/$dir/$file"
  fi
  printf '%-44s %-9s sha256:%s\n' "$out" "$licence" "$(sha256sum "$out" | cut -c1-16)" >> LICENCES.txt
done

# One copy of the licence text per family directory used.
for d in ptsans ptmono sourceserif4 courierprime archivonarrow ebgaramond nunito spacegrotesk; do
  curl -sSLf --max-time 30 -o "OFL-$d.txt" "$base/ofl/$d/OFL.txt" 2>/dev/null || true
done

echo "fonts ready:"; ls -1 *.ttf | sed 's/^/  /'
