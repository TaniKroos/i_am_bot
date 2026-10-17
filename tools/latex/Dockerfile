# Contained LaTeX toolchain for resume builds.
# Ubuntu 24.04 ships TeX Live 2023 / pdfTeX 1.40.25 — the same build the owner's current resume PDF was made with,
# so line breaks and page fit match.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended texlive-fonts-extra lmodern \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/*
# Ubuntu 24.04 already has an unprivileged uid 1000 ("ubuntu"); the wrapper runs as the owner's uid anyway.
USER ubuntu
WORKDIR /work
