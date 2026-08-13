# Shared CLI/TUI interaction prototype

Estado: evidencia histórica descartable. No es una superficie de producción.

## Pregunta

¿Una única Interaction session que conserva el mismo snapshot, draft, resolución,
plan y stream de Operation events puede alimentar CLI y TUI sin duplicar reglas;
mostrar dependencias; exigir el plan ID exacto; y representar cancelación, rollback,
verification failure y recovery sin ocultar estados?

## Ejecutar

TUI sobre un repositorio Go temporal:

```bash
pnpm prototype:interaction
```

Plan headless con JSON atómico:

```bash
pnpm prototype:interaction init --recommended --harness codex --format json
```

Apply completo con eventos NDJSON:

```bash
pnpm prototype:interaction init --recommended --harness codex --yes --format ndjson
```

El runner compila el prototipo en un directorio temporal. La demo crea además otro
directorio temporal para el repositorio candidato, escribe `go.mod`, usa el catálogo
real y el adapter Codex real, ejecuta el planner y mutation engine reales y elimina
ambos directorios al salir. Nunca usa el CWD como destino ni deja `dist/`.

Para explorar estados difíciles de provocar de forma segura, abrir
[interaction-prototype.html](./interaction-prototype.html) en un navegador. Incluye
free play y walkthroughs de install, remove, cancelación, rollback, preflight,
certification failure y recovery.

## Estructura

- `model.ts`: vocabulario observable y reducer puro.
- `session.ts`: único coordinador de scan, draft, plan, aprobación, apply, verify y
  receipt sobre los casos de uso reales.
- `headless.ts`: proyección JSON/NDJSON y exit codes; no contiene resolución ni reglas
  de mutación.
- `tui-app.tsx`: controller de input y proyección Ink del mismo snapshot y eventos.
- `tui-presenter.ts`: derivaciones puras de layout, health, copy y formato; no conoce
  React, filesystem ni casos de uso.
- `main.tsx`: runner aislado del prototipo.
- `interaction-prototype.html`: laboratorio HITL autocontenido de la máquina de estados.

## Alcance

Este directorio conserva únicamente el experimento que validó compartir una sesión
entre CLI y TUI. La implementación productiva vive en `src/interaction`, `src/cli.ts`
y `src/tui`; sus contratos y pruebas son autoritativos. No se deben incorporar
features ni correcciones al prototipo.
