# Cross-Cutting Principles

These principles apply across all skills and workflows.

1. **Atomicity**: Ensure operations are atomic where possible. If an operation involves multiple steps (e.g., file write + database insert), provide rollback mechanisms for partial failures.

2. **Idempotency**: Design operations to be idempotent where feasible, so repeating them doesn't cause duplicate side effects.

3. **Error Handling**: Always handle errors gracefully and provide meaningful error messages. Clean up resources on failure.

4. **Security**: Validate inputs, sanitize data, and follow security best practices (e.g., file upload validation, SQL injection prevention).

5. **Observability**: Log important operations and errors for debugging and monitoring.

6. **Simplicity**: Prefer simple, clear solutions over complex ones. Avoid unnecessary abstractions.

7. **Reusability**: Design components and patterns that can be reused across the codebase.

8. **Consistency**: Follow existing patterns and conventions in the codebase.

9. **Performance**: Consider performance implications, but optimize only when necessary and measurable.

10. **Documentation**: Document complex logic and public APIs. Keep documentation close to the code.