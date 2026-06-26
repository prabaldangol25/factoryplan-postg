FROM rust:1.92-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/factoryplan-backend /usr/local/bin/factoryplan-backend

ENV HOST=0.0.0.0
ENV PORT=8080
ENV RUST_LOG=info

EXPOSE 8080
CMD ["factoryplan-backend"]
