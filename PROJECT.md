# AI Agent SDK — Project Brief

## Overview

Build an open-source AI Agent SDK from scratch using TypeScript. Give the SDK an
original name inspired by your name or identity.

You may decide how developers use the SDK — through classes, functions,
configuration objects, builders, plugins, or any other clean API design. The SDK
must be written by you in raw TypeScript or JavaScript. You may use model APIs,
validation libraries, and utilities, but the **core agent behavior must not be
provided by another agent framework**.

---

## Requirements

### What the SDK must allow a developer to do

- Define an agent (instructions + model + tools)
- Run an agent loop and receive a final result
- Handle failures safely

---

## Section Breakdown

### 1. Agent Runtime _(15 marks)_

Build your own agent loop that:

- Accepts user input
- Sends context and instructions to an LLM
- Detects tool calls
- Executes tools
- Sends tool results back to the model
- Continues until a final answer is produced
- Stops when limits are reached

### 2. Tools _(10 marks)_

Developers should be able to define custom tools with:

- `name`, `description`
- Input schema, execution function
- Typed result, error handling

Support input validation and asynchronous tools.

### 3. Agent Capabilities _(bonus)_

Implement as many meaningful capabilities as possible:

- Multi-agent handoffs
- Input/output guardrails
- Tool guardrails
- Memory and sessions
- Structured outputs
- Streaming and retries
- Model provider abstraction
- Model fallback

> Marks depend on how many useful capabilities work correctly, not how many
> configuration fields exist.

### 4. Memory and Sessions _(10 marks)_

Support multi-turn conversations. Storage options:

- In-memory, files, SQLite, Redis, another database, or custom storage adapters

The SDK should clearly separate:

- Agent configuration
- Current run state
- Persistent session state

### 5. Handoffs _(10 marks)_

Allow one agent to delegate or transfer a task to another agent. The handoff should:

- Preserve the required context
- Identify the new agent
- Avoid endless handoff loops
- Appear in logs or traces

### 6. Guardrails _(10 marks)_

Support validation before or after agent execution. Examples:

- Reject invalid input
- Prevent dangerous tool calls
- Validate structured output
- Remove sensitive information
- Require approval for risky actions

### 7. Structured Output _(10 marks)_

Allow developers to define an expected response schema. The SDK should:

- Validate the output
- Return useful validation errors
- Retry or repair invalid output if supported
- Preserve TypeScript types where possible

### 8. Streaming and Events _(10 marks)_

Expose useful runtime events:

- Text streamed
- Tool started / completed
- Handoff started
- Guardrail triggered
- Run completed / failed

May use async iterators, callbacks, event emitters, or streams.

### 9. Tracing and Reliability _(10 marks)_

Provide traces containing:

- Run ID, agent name, model calls
- Tool calls, handoffs, retries
- Errors, timing, token usage
- Final output

### 10. Model Providers _(bonus)_

Avoid tightly coupling the SDK to one model provider. Create a provider
abstraction so developers can add:

- OpenAI, Claude, Gemini, and others

---

## Documentation

Create and host documentation. It should cover:

- Installation
- Quick start and API usage
- Tools, Handoffs, Guardrails
- Memory and sessions
- Structured output and streaming
- Tracing and error handling
- Examples

> A developer should be able to use the SDK without reading the source code.

---

## Product & Pitch

Treat this project like a developer startup applying to Y Combinator. Clearly explain:

- Who the SDK is for
- What problem it solves
- Why it should exist
- How it differs from existing SDKs
- Why developers should adopt it

Record a video (face on camera) demonstrating the product. Post publicly on X,
LinkedIn, or Instagram.

---

## Submission Checklist

- [ ] Public GitHub repository
- [ ] Hosted documentation
- [ ] Demo link (if available)
- [ ] npm package link (if published)
- [ ] Public social media post

---

## Evaluation Criteria

> Review the submission like a startup investment decision: if your own $500,000
> were at stake, would you invest in this SDK and its builder?

| Area                            | Marks   |
| ------------------------------- | ------- |
| Agent Runtime                   | 15      |
| Tools                           | 10      |
| Handoffs                        | 10      |
| Guardrails                      | 10      |
| Memory and Sessions             | 10      |
| Structured Output and Streaming | 10      |
| Reliability                     | 10      |
| Tracing                         | 5       |
| Developer Experience            | 10      |
| Documentation and Examples      | 10      |
| Product Thinking                | 10      |
| Demo and Pitch                  | 10      |
| **Total**                       | **110** |

### Detailed Rubric

**Agent Runtime (15)**

- Original agent loop
- Multi-turn execution
- Tool-call handling
- Safe stopping conditions
- Clear final result

**Tools (10)**

- Custom tool creation
- Input validation
- Async execution
- Typed results
- Error handling

**Handoffs (10)**

- Working multi-agent delegation
- Correct context transfer
- Handoff-loop prevention
- Clear documentation

**Guardrails (10)**

- Input or output validation
- Tool safety
- Controlled failures
- Approval support where applicable

**Memory and Sessions (10)**

- Multi-turn state
- Persistent session support
- Clean storage abstraction
- Context management

**Structured Output and Streaming (10)**

- Schema validation
- Typed output
- Invalid-output handling
- Useful runtime events

**Reliability (10)**

- Retries
- Timeouts
- Clear errors
- Loop prevention
- Safe secret handling

**Tracing (5)**

- Tool calls and handoffs visible
- Timing and errors recorded
- Useful debugging information

**Developer Experience (10)**

- Clean API design
- Strong TypeScript support
- Sensible defaults
- Clear error messages
- Easy setup

**Documentation and Examples (10)**

- Hosted documentation
- Working quick start
- At least two examples
- Clear API reference

**Product Thinking (10)**

- Clear target user
- Strong differentiation
- Real problem being solved
- Believable product direction

**Demo and Pitch (10)**

- Student appears in the video
- Product is demonstrated clearly
- Technical decisions are explained
- Pitch is convincing
