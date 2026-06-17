FROM rust:1-bookworm AS builder
WORKDIR /workspace

COPY crates ./crates
WORKDIR /workspace/crates
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /workspace/crates/target/release/cerida-api /usr/local/bin/cerida-api
COPY --from=builder /workspace/crates/target/release/cerida-indexer /usr/local/bin/cerida-indexer
COPY --from=builder /workspace/crates/target/release/cerida-keeper /usr/local/bin/cerida-keeper

CMD ["cerida-api"]
