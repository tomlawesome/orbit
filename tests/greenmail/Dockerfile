# The acceptance stack's mail server (#459), with the leaked eMudhra roots
# taken out of both trust stores (#1489, CVE-2026-111943). GreenMail's newest
# image still trusts them, so this builds on that pinned digest the way
# tests/dkim-dns builds on the pinned node image: no new third-party image.
# Drop this file and pin upstream again once a GreenMail release ships
# without them (re-check at each GreenMail release).
#
# Removed: every root whose subject has O=eMudhra (emSign), plus Comodo's
# AAA Certificate Services and COMODO ECC / RSA Certification Authority.
FROM greenmail/standalone:2.1.15@sha256:309ba544ea482e5d4265d09921cdab07c8dad2cc4481d715c9b8ff5d3f0a149f

USER root
RUN set -eu; \
    keytool -list -v -cacerts -storepass changeit \
      | awk '/^Alias name: /{sub(/^Alias name: /, ""); a=$0} /^Owner:/ && (/O=eMudhra/ || /CN=AAA Certificate Services/ || /CN=COMODO (ECC|RSA) Certification Authority/){print a}' \
      > /tmp/blocked-aliases; \
    test -s /tmp/blocked-aliases; \
    while IFS= read -r alias; do \
      keytool -delete -noprompt -cacerts -storepass changeit -alias "$alias"; \
    done < /tmp/blocked-aliases; \
    rm /tmp/blocked-aliases; \
    for pem in /usr/share/ca-certificates/mozilla/*.crt; do \
      subject="$(openssl x509 -noout -subject -nameopt RFC2253 -in "$pem")"; \
      case "$subject" in \
        *O=eMudhra*|*"CN=AAA Certificate Services"*|*"CN=COMODO ECC Certification Authority"*|*"CN=COMODO RSA Certification Authority"*) \
          sed -i "s|^mozilla/$(basename "$pem")\$|!mozilla/$(basename "$pem")|" /etc/ca-certificates.conf ;; \
      esac; \
    done; \
    update-ca-certificates --fresh > /dev/null
USER greenmail
