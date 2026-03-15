# Common Rust Compiler Errors — Quick Fixes

## Borrow Checker

### E0502: Cannot borrow `x` as mutable because also borrowed as immutable
- **Fix 1 (Re-scope)**: Use `{}` block to drop immutable borrow before mutation
- **Fix 2 (Clone)**: `let val = x[0].clone(); x.push(val);`

### E0382: Use of moved value
- **Fix 1 (Reference)**: Pass `&x` if ownership transfer isn't needed
- **Fix 2 (Clone)**: `x.clone()` if consumer needs ownership
- **Fix 3 (Copy)**: Derive `Copy` if type is trivial

### E0597: `x` does not live long enough
- **Fix 1 (Ownership)**: Return `String` (owned) not `&str` (borrowed)
- **Fix 2 (Lifetime lifting)**: Declare storage outside the scope where ref is taken

### E0499: Cannot borrow `x` as mutable more than once
- **Fix 1**: Split struct fields into separate variables
- **Fix 2**: Use indices instead of references for collections
- **Fix 3**: Interior mutability (`RefCell`, `Mutex`) as last resort

## Async-Specific

### "future cannot be sent between threads safely"
- **Cause**: Holding a non-Send type (e.g., `Rc`, `RefCell`) across `.await`
- **Fix**: Use `Arc` + `tokio::sync::Mutex` instead of `Rc` + `RefCell`
- **Fix 2**: Scope the non-Send value so it's dropped before `.await`

### "this `MutexGuard` is held across an `await` point"
- **Cause**: Lock guard lives across `.await` — potential deadlock
- **Fix**: Clone data out, drop guard, then await:
  ```rust
  let value = { data.lock().await.clone() };
  use_value(value).await;
  ```

### "`impl Trait` not allowed in trait method return"
- **Fix**: Use `async-trait` crate (until RPITIT stabilizes fully)
- Note: Rust 1.75+ supports `async fn` in traits natively for many cases

## Type System

### E0277: Trait bound not satisfied
- Check: Did you `derive` the trait? (`#[derive(Clone, Debug, Serialize)]`)
- Check: Is the trait in scope? (`use std::fmt::Display;`)
- Check: All generic params satisfy the bound?

### E0308: Mismatched types
- Common: `String` vs `&str` — use `.as_str()` or `&*s`
- Common: `Option<T>` vs `T` — use `?` or `.unwrap_or_default()`
- Common: `Result<T, E1>` vs `Result<T, E2>` — add `#[from]` to thiserror enum

## Lifetime

### "missing lifetime specifier"
- Add explicit lifetime: `fn foo<'a>(x: &'a str) -> &'a str`
- If returning owned data, don't return reference: `fn foo(x: &str) -> String`

### "lifetime may not live long enough"
- Check: Are you storing a reference in a struct? Add lifetime param: `struct Foo<'a> { bar: &'a str }`
- Check: Returning a reference to a local? Return owned instead.

## Debug Workflow

1. Read the **full** error message — Rust's errors are excellent
2. Look at the **help** line — it often has the exact fix
3. If borrow checker: draw the ownership/borrow timeline on paper
4. If lifetime: ask "who owns this data and how long does it live?"
5. If async: check for non-Send types and lock guards across awaits
6. Use `dbg!()` for quick value inspection (remove before commit)
7. `cargo clippy --fix` auto-fixes many common issues
