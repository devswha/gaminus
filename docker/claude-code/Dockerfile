# Build from the repository root:
# docker build --file docker/claude-code/Dockerfile --tag gaminus-sandbox:claude-code .
FROM docker/sandbox-templates:claude-code

USER root
WORKDIR /opt/gaminus
COPY --chown=agent:agent package.json package-lock.json LICENSE NOTICE ./
COPY --chown=agent:agent dist ./dist
COPY --chown=agent:agent dist-server ./dist-server
COPY --chown=agent:agent public ./public
COPY --chown=agent:agent shared ./shared
COPY --chown=agent:agent node_modules ./node_modules
COPY docker/shared/install-gaminus.sh /tmp/install-gaminus.sh
RUN chmod +x /tmp/install-gaminus.sh && /tmp/install-gaminus.sh /opt/gaminus

COPY --chown=agent:agent docker/shared/start-gaminus.sh /home/agent/.gaminus-start.sh
RUN printf '\n. /home/agent/.gaminus-start.sh\n' >> /home/agent/.bashrc

USER agent
WORKDIR /home/agent
