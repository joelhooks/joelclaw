FROM python:3.13-alpine@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0

WORKDIR /app
COPY --chmod=0644 server.py /app/server.py

USER 65534:65534
EXPOSE 7411
ENTRYPOINT ["python3", "/app/server.py"]
