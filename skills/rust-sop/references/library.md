# Rust Library — pdf-brain Reference

The joelclaw pdf-brain contains Rust books that have been chunked, classified, and vector-indexed. **Always search the library before writing non-trivial Rust code** — it contains authoritative patterns from the best Rust books.

## How to Search

```bash
# Text search — fast, keyword-based
joelclaw docs search "query terms"

# Get full context around a chunk
joelclaw docs context <chunk-id> --mode snippet-window
```

## Few-Shot Search Examples

### Ownership & Borrowing
```bash
# When dealing with lifetimes, borrow checker errors, ownership transfer
joelclaw docs search "ownership borrowing move semantics"
joelclaw docs search "lifetime annotations struct"
joelclaw docs search "borrow checker mutable immutable reference"
joelclaw docs search "smart pointers Box Rc Arc"
joelclaw docs search "interior mutability RefCell Cell"
joelclaw docs search "clone on write Cow"
```

### Error Handling
```bash
# When designing error types or handling Result/Option
joelclaw docs search "thiserror custom error types"
joelclaw docs search "anyhow context error propagation"
joelclaw docs search "Result Option combinators map and_then"
joelclaw docs search "error handling question mark operator"
```

### Async & Concurrency
```bash
# When writing tokio async code, channels, shared state
joelclaw docs search "tokio async await runtime"
joelclaw docs search "tokio spawn select join"
joelclaw docs search "channels mpsc oneshot broadcast"
joelclaw docs search "async mutex rwlock shared state"
joelclaw docs search "graceful shutdown signal handling"
joelclaw docs search "futures streams async iterator"
joelclaw docs search "spawn_blocking CPU bound work"
```

### Traits & Generics
```bash
# When designing trait hierarchies, generic abstractions
joelclaw docs search "trait objects dynamic dispatch dyn"
joelclaw docs search "generic bounds where clause"
joelclaw docs search "associated types trait design"
joelclaw docs search "impl Trait return position"
```

### Web / Server (Axum)
```bash
# When building HTTP services, middleware, routing
joelclaw docs search "axum router handler extractor"
joelclaw docs search "web server middleware tower"
joelclaw docs search "REST API JSON serialization"
joelclaw docs search "websocket server tokio tungstenite"
joelclaw docs search "TLS HTTPS rustls"
```

### Testing
```bash
# When writing tests, benchmarks, property tests
joelclaw docs search "rust unit test integration test"
joelclaw docs search "mock testing trait objects"
joelclaw docs search "property based testing proptest"
joelclaw docs search "benchmark criterion performance"
```

### Systems / Low-Level
```bash
# When dealing with memory, unsafe, FFI, atomics
joelclaw docs search "unsafe rust safety invariant"
joelclaw docs search "atomic operations memory ordering"
joelclaw docs search "FFI foreign function interface C"
joelclaw docs search "Pin Unpin self-referential"
joelclaw docs search "zero cost abstractions performance"
```

### Project Structure & Patterns
```bash
# When scaffolding projects, organizing modules
joelclaw docs search "cargo workspace project structure"
joelclaw docs search "module system pub crate visibility"
joelclaw docs search "builder pattern rust idiomatic"
joelclaw docs search "type state pattern compile time"
joelclaw docs search "newtype pattern wrapper type"
```

## Available Books

These books are indexed (or being indexed) in pdf-brain:

| Book | Best For |
|------|----------|
| The Rust Programming Language (2nd ed) | Canonical intro, all fundamentals |
| Programming Rust (Blandy/Orendorff) | Deeper systems coverage, ownership model |
| Rust in Action (McNamara) | Systems programming, practical projects |
| Rust for Rustaceans (Gjengset) | Intermediate/advanced patterns, idioms |
| Zero to Production in Rust (Palmieri) | Web/backend with Axum, testing, CI |
| Rust Atomics and Locks (Bos) | Concurrency primitives, memory ordering |
| Rust Design Patterns | Idiomatic patterns, anti-patterns |

## Workflow: Library-Informed Development

1. **Before implementing**: Search the library for the pattern you need
2. **Read the chunk context**: `joelclaw docs context <id> --mode snippet-window`
3. **Adapt, don't copy**: Book patterns are teaching examples — adapt to clawnode conventions
4. **When stuck on a compiler error**: Search for the error code or concept
5. **When designing an API**: Search for trait design, builder patterns, or similar abstractions

## Tips

- Search terms should be conceptual, not exact phrases: "ownership move" not "the ownership system moves values"
- Combine domain + concept: "async error handling" not just "error handling"
- Use `--mode snippet-window` on context to get surrounding chunks for fuller picture
- If text search returns noise, try narrower terms or check the book title filter
