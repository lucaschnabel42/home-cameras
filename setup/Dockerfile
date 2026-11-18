# The setup tool (setup.py): init, sync, doctor. It runs on the compose
# network with the project folder at /work, so the host needs only Docker.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/app/setup.py"]
CMD ["doctor"]
