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
  # --- added for the 18 further documents (#986) ---
  "ofl/ptserif|PT_Serif-Web-Regular.ttf|OFL-1.1"
  "ofl/ptserif|PT_Serif-Web-Bold.ttf|OFL-1.1"
  "ofl/ibmplexsans|IBMPlexSans%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/librebaskerville|LibreBaskerville%5Bwght%5D.ttf|OFL-1.1"
  "ofl/publicsans|PublicSans%5Bwght%5D.ttf|OFL-1.1"
  "ofl/firasans|FiraSans-Regular.ttf|OFL-1.1"
  "ofl/firasans|FiraSans-Bold.ttf|OFL-1.1"
  "ofl/firamono|FiraMono-Regular.ttf|OFL-1.1"
  "ofl/sharetechmono|ShareTechMono-Regular.ttf|OFL-1.1"
  "ofl/worksans|WorkSans%5Bwght%5D.ttf|OFL-1.1"
  "ofl/jetbrainsmono|JetBrainsMono%5Bwght%5D.ttf|OFL-1.1"
  "ofl/crimsonpro|CrimsonPro%5Bwght%5D.ttf|OFL-1.1"
  "ofl/karla|Karla%5Bwght%5D.ttf|OFL-1.1"
  "ofl/spectral|Spectral-Regular.ttf|OFL-1.1"
  "ofl/cabin|Cabin%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/rubik|Rubik%5Bwght%5D.ttf|OFL-1.1"
  "ofl/bitter|Bitter%5Bwght%5D.ttf|OFL-1.1"
  "ofl/lora|Lora%5Bwght%5D.ttf|OFL-1.1"
  "ofl/oswald|Oswald%5Bwght%5D.ttf|OFL-1.1"
  "ofl/anonymouspro|AnonymousPro-Regular.ttf|OFL-1.1"
  "ofl/cutivemono|CutiveMono-Regular.ttf|OFL-1.1"
  "ofl/inconsolata|Inconsolata%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/zillaslab|ZillaSlab-Regular.ttf|OFL-1.1"
  "ofl/alegreya|Alegreya%5Bwght%5D.ttf|OFL-1.1"
  "ofl/barlow|Barlow-Regular.ttf|OFL-1.1"
  # A marker hand, for the values written into a form at a desk.
  "ofl/caveat|Caveat%5Bwght%5D.ttf|OFL-1.1"
  "ofl/mulish|Mulish%5Bwght%5D.ttf|OFL-1.1"
  "ofl/asap|Asap%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/arvo|Arvo-Regular.ttf|OFL-1.1"
  "ofl/domine|Domine%5Bwght%5D.ttf|OFL-1.1"
  "ofl/saira|Saira%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/manrope|Manrope%5Bwght%5D.ttf|OFL-1.1"
  "ofl/vollkorn|Vollkorn%5Bwght%5D.ttf|OFL-1.1"
  "ofl/tinos|Tinos-Regular.ttf|OFL-1.1"
  "ofl/cormorantgaramond|CormorantGaramond%5Bwght%5D.ttf|OFL-1.1"
  # --- added for the 12 hold-out documents (#986 step 8) ---
  "ofl/literata|Literata%5Bopsz,wght%5D.ttf|OFL-1.1"
  "ofl/librefranklin|LibreFranklin%5Bwght%5D.ttf|OFL-1.1"
  "ofl/faustina|Faustina%5Bwght%5D.ttf|OFL-1.1"
  "ofl/inter|Inter%5Bopsz,wght%5D.ttf|OFL-1.1"
  "ofl/newsreader|Newsreader%5Bopsz,wght%5D.ttf|OFL-1.1"
  "ofl/spacemono|SpaceMono-Regular.ttf|OFL-1.1"
  "ofl/spacemono|SpaceMono-Bold.ttf|OFL-1.1"
  "ofl/archivo|Archivo%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/sourcecodepro|SourceCodePro%5Bwght%5D.ttf|OFL-1.1"
  "ofl/martianmono|MartianMono%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/epilogue|Epilogue%5Bwght%5D.ttf|OFL-1.1"
  "ofl/redhatdisplay|RedHatDisplay%5Bwght%5D.ttf|OFL-1.1"
  "ofl/plusjakartasans|PlusJakartaSans%5Bwght%5D.ttf|OFL-1.1"
  "ofl/josefinsans|JosefinSans%5Bwght%5D.ttf|OFL-1.1"
  "ofl/gelasio|Gelasio%5Bwght%5D.ttf|OFL-1.1"
  "ofl/sourcesans3|SourceSans3%5Bwght%5D.ttf|OFL-1.1"
  "ofl/petrona|Petrona%5Bwght%5D.ttf|OFL-1.1"
  "ofl/dmserifdisplay|DMSerifDisplay-Regular.ttf|OFL-1.1"
  # A ballpoint hand, for a carbonless pad filled in on a doorstep.
  "ofl/kalam|Kalam-Regular.ttf|OFL-1.1"
  "ofl/kalam|Kalam-Bold.ttf|OFL-1.1"
  # --- added for the SECOND hold-out, 12 further documents (#997) ---
  # Twenty-three more faces, none used by `sources/` or the first `holdout/`,
  # so this third corpus shares no character map with either of the other two.
  "ofl/playfairdisplay|PlayfairDisplay%5Bwght%5D.ttf|OFL-1.1"
  "ofl/nunitosans|NunitoSans%5BYTLC,opsz,wdth,wght%5D.ttf|OFL-1.1"
  "ofl/notoserif|NotoSerif%5Bwdth,wght%5D.ttf|OFL-1.1"
  "ofl/ibmplexmono|IBMPlexMono-Regular.ttf|OFL-1.1"
  "ofl/ibmplexmono|IBMPlexMono-Bold.ttf|OFL-1.1"
  "ofl/cardo|Cardo-Regular.ttf|OFL-1.1"
  "ofl/cardo|Cardo-Bold.ttf|OFL-1.1"
  "ofl/overpass|Overpass%5Bwght%5D.ttf|OFL-1.1"
  "ofl/overpassmono|OverpassMono%5Bwght%5D.ttf|OFL-1.1"
  "ofl/chivo|Chivo%5Bwght%5D.ttf|OFL-1.1"
  "ofl/neuton|Neuton-Regular.ttf|OFL-1.1"
  "ofl/neuton|Neuton-Bold.ttf|OFL-1.1"
  "ofl/dmsans|DMSans%5Bopsz,wght%5D.ttf|OFL-1.1"
  "ofl/poppins|Poppins-Regular.ttf|OFL-1.1"
  "ofl/poppins|Poppins-Bold.ttf|OFL-1.1"
  "ofl/dmmono|DMMono-Regular.ttf|OFL-1.1"
  "ofl/raleway|Raleway%5Bwght%5D.ttf|OFL-1.1"
  "ofl/cousine|Cousine-Regular.ttf|OFL-1.1"
  "ofl/cousine|Cousine-Bold.ttf|OFL-1.1"
  "ofl/hankengrotesk|HankenGrotesk%5Bwght%5D.ttf|OFL-1.1"
  "ofl/quicksand|Quicksand%5Bwght%5D.ttf|OFL-1.1"
  "ofl/breeserif|BreeSerif-Regular.ttf|OFL-1.1"
  "ofl/patrickhand|PatrickHand-Regular.ttf|OFL-1.1"
  "ofl/sora|Sora%5Bwght%5D.ttf|OFL-1.1"
  "ofl/cormorant|Cormorant%5Bwght%5D.ttf|OFL-1.1"
  "ofl/librecaslontext|LibreCaslonText%5Bwght%5D.ttf|OFL-1.1"
  "ofl/firacode|FiraCode%5Bwght%5D.ttf|OFL-1.1"
  "ofl/bevan|Bevan-Regular.ttf|OFL-1.1"
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
for d in ptsans ptmono sourceserif4 courierprime archivonarrow ebgaramond nunito spacegrotesk \
         ptserif ibmplexsans librebaskerville publicsans firasans firamono sharetechmono \
         worksans jetbrainsmono crimsonpro karla \
         spectral cabin rubik bitter lora oswald anonymouspro cutivemono \
         inconsolata zillaslab alegreya barlow caveat mulish asap \
         arvo domine saira manrope vollkorn tinos cormorantgaramond \
         literata librefranklin faustina inter newsreader spacemono archivo \
         sourcecodepro martianmono epilogue redhatdisplay plusjakartasans \
         josefinsans gelasio sourcesans3 petrona dmserifdisplay kalam \
         playfairdisplay nunitosans notoserif ibmplexmono cardo overpass \
         overpassmono chivo neuton dmsans poppins dmmono raleway cousine \
         hankengrotesk quicksand breeserif patrickhand sora cormorant \
         librecaslontext firacode bevan; do
  curl -sSLf --max-time 30 -o "OFL-$d.txt" "$base/ofl/$d/OFL.txt" 2>/dev/null || true
done

echo "fonts ready:"; ls -1 *.ttf | sed 's/^/  /'
