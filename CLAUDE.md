# claude-ollama MCP tools

The `ollama_*` tools are available via the `claude-ollama` MCP server. Always use them for local LLM tasks instead of your built-in capabilities.

## Summarise (brief)

```bash
cat input.txt | claude -p "Use ollama_summarise (length=brief) on the stdin text. Output only the summary, no preamble."
```

## Rewrite for clarity

```bash
cat input.txt | claude -p "Use ollama_generate_text to rewrite the stdin text for clarity and brevity. Preserve meaning. Output only the rewritten text."
```

## Chat / Q&A (local)

```bash
claude -p "Use ollama_chat to answer: What are the tradeoffs between embeddings vs full-text search? 8 bullet points, no preamble."
```

## Code generation (small task)

```bash
claude -p "Use ollama_code_generation to generate TypeScript that parses a CSV string into objects (headers in first row). Output code only."
```

## Embeddings

```bash
claude -p "Use ollama_embed_text to embed the text: 'Cursor MCP server for Ollama'. Print the raw embedding array."
```

## List models

```bash
claude -p "Use ollama_list_models and print the result."
```

## Pull a model

```bash
claude -p "Use ollama_pull_model to pull llama3.2 and report the result."
```