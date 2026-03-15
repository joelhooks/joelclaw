# Ownership, Borrowing & Lifetimes — Quick Reference

## Core Rules

1. Each value has exactly one owner
2. When owner goes out of scope, value is dropped
3. You can have either ONE `&mut T` OR any number of `&T` — never both

## Borrowing Patterns

```rust
// Immutable borrow — read-only, multiple allowed
fn len(s: &str) -> usize { s.len() }

// Mutable borrow — read+write, exclusive
fn push(s: &mut String) { s.push_str(" world"); }

// Move — ownership transfer
fn consume(s: String) { drop(s); }
```

## Smart Pointers

| Type | Use Case | Thread-safe? |
|------|----------|-------------|
| `Box<T>` | Heap allocation, single owner | Yes (if T: Send) |
| `Rc<T>` | Shared ownership, single thread | No |
| `Arc<T>` | Shared ownership, multi-thread | Yes |
| `RefCell<T>` | Interior mutability, single thread | No |
| `Mutex<T>` | Interior mutability, multi-thread | Yes |
| `RwLock<T>` | Read-heavy shared state | Yes |
| `Cow<'a, T>` | Clone-on-write (avoid allocation when possible) | Depends on T |

## Common Combos

- `Arc<Mutex<T>>` — shared mutable state across async tasks
- `Rc<RefCell<T>>` — shared mutable state in single thread (avoid in async)
- `Arc<RwLock<T>>` — read-heavy shared state across tasks

## Lifetime Annotations

```rust
// Output lifetime tied to input
fn first<'a>(s: &'a str) -> &'a str { &s[..1] }

// Struct borrowing data
struct View<'a> { data: &'a [u8] }

// Static lifetime — lives forever
const NAME: &'static str = "clawnode";

// Lifetime elision (compiler infers these):
fn foo(s: &str) -> &str { s }  // Same as fn foo<'a>(s: &'a str) -> &'a str
```

## Builder Pattern (Ownership-Friendly)

```rust
struct Config { host: String, port: u16 }

struct ConfigBuilder { host: Option<String>, port: Option<u16> }

impl ConfigBuilder {
    fn new() -> Self { Self { host: None, port: None } }
    fn host(mut self, h: impl Into<String>) -> Self { self.host = Some(h.into()); self }
    fn port(mut self, p: u16) -> Self { self.port = Some(p); self }
    fn build(self) -> anyhow::Result<Config> {
        Ok(Config {
            host: self.host.context("host required")?,
            port: self.port.unwrap_or(2583),
        })
    }
}
```

## Decision Tree: Borrow or Own?

1. Does the callee need to store it long-term? → **Own** (take `T`)
2. Does the callee need to mutate it? → **`&mut T`**
3. Just reading? → **`&T`**
4. Need to return it from a function? → Check if you can return `&T` with lifetime, otherwise **Own**
5. Conditional mutation? → **`Cow<T>`**
