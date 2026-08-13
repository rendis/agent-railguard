# AI Harness Marketplace

AI Harness Marketplace prepara un repositorio consumidor con capacidades reutilizables
para los AI coding harnesses que el equipo ya utiliza. Este glosario separa la intención
portable del producto de la materialización particular de cada harness.

## Language

**Harness**:
Runtime o aplicación de desarrollo asistido por IA que consume instrucciones,
skills, agentes, herramientas y configuración del usuario.
_Avoid_: Agent, marketplace

**Project scope**:
Ámbito del repositorio consumidor en el que AI Harness administra todos sus
componentes. Excluye la configuración personal o global de los harnesses.
_Avoid_: User scope, global scope

**Project unit**:
Boundary relativo dentro de un repositorio que agrupa evidencia de uno o más
ecosistemas, manifiestos y tareas nativas. Un monorepo puede contener
varias unidades; no equivale al repositorio completo ni a un harness target.
_Avoid_: Main language, workspace cuando no se ha demostrado

**Component**:
Unidad versionada del catálogo que AI Harness puede seleccionar, relacionar y
administrar. Cada componente tiene un tipo explícito y no cambia de significado
según el harness.
_Avoid_: Thing, resource

**Component definition**:
Entrada tipada dentro de `ai-harness.yaml` que conserva sólo las decisiones de
distribución no derivables de un componente. Cada tipo define sus hechos derivados;
para una skill no reemplaza ni duplica `SKILL.md`.
_Avoid_: Component manifest, SKILL.md frontmatter, lock state

**Catalog snapshot**:
Vista inmutable y completamente validada de una revisión exacta del catálogo, con
componentes normalizados e integridad reproducible. Nunca es un catálogo parcial.
_Avoid_: Manifest tree, catalog cache

**Component relation**:
Edge declarado en la definición central desde un componente origen hacia un destino.
Su kind indica si el Resolver debe agregar, sugerir, asociar o rechazar esa combinación.
No representa una llamada ni una transferencia de control entre skills.
_Avoid_: Skill call, control flow

**Skill**:
Componente de instrucciones y recursos que enseña un workflow reutilizable y se
carga cuando una tarea coincide con su propósito. El agente carga y coordina las
skills; una skill no ejecuta, llama ni devuelve control a otra.
_Avoid_: Agent, prompt

**Agent**:
Componente que define un rol especializado, su autoridad y sus capacidades para un
harness que soporte agentes o subagentes configurables.
_Avoid_: Harness, pack, skill

**MCP integration**:
Componente que declara una conexión MCP, las herramientas o datos que expone y sus
requisitos de transporte, autenticación y permisos.
_Avoid_: MCP, plugin

**Instruction mapping**:
Definición interna, no seleccionable, que un adapter renderiza como una managed section
por grupo de componentes sin apropiarse del archivo de destino completo.
_Avoid_: Prompt, managed file

**Harness hook**:
Componente ejecutado en un evento del ciclo de vida de un AI harness, como antes de
una llamada de herramienta o al terminar una sesión del agente.
_Avoid_: Git gate, hook

**Git gate**:
Verificación local que asocia uno o más canonical checks a un evento de Git como
commit o push. Aporta feedback temprano y no equivale al enforcement de CI.
_Avoid_: Harness hook, hook

**Verification profile**:
Componente de configuración que define una base reproducible de checks y los inputs
semánticos necesarios para adaptarla a una clase de repositorio.
_Avoid_: Quality skill, Git gate

**Verification manifest**:
Declaración resuelta del proyecto que vincula un verification profile y sus inputs
aprobados con canonical checks y eventos de Git.
_Avoid_: Lock state, skill configuration

**Canonical check**:
Entrada ejecutable propiedad del repositorio, con scope explícito y fallo no cero,
que implementa una verificación mecánica sin depender de una skill.
_Avoid_: Skill helper, agent instruction

**Pack**:
Selección instalable de componentes que entrega una capacidad completa. Un pack
puede incluir skills, integraciones MCP, agentes y configuración, pero no es cargado
por el modelo como una skill.
_Avoid_: Plugin, agent bundle

**Pack member**:
Componente que forma parte declarada de un pack y se agrega cuando ese pack es una
selección directa. Puede tener a su vez requisitos transitivos.
_Avoid_: Direct selection, transitive requirement

**Plugin**:
Extensión nativa de un harness, empaquetada conforme al contrato de ese host. No es
el nombre de una agrupación genérica del marketplace.
_Avoid_: Pack

**Repository assessment**:
Vista read-only y explicable de las project units, ecosistemas, manifests y tareas
nativas observadas en un snapshot. Puede estar vacía y nunca elige un lenguaje principal.
_Avoid_: Language guess, main language

**Stack adapter**:
Módulo read-only registrado para un ecosistema que aporta roots, manifiestos, tareas y
evidencia a Repository assessment. No conoce otros stacks, harnesses ni recomendaciones.
_Avoid_: Harness adapter, recommender, file language classifier

**File language classifier**:
Clasificador opcional que etiqueta archivos por nombre, extensión o contenido acotado.
Su evidencia no crea por sí sola una project unit ni determina recomendaciones.
_Avoid_: Stack adapter, repository assessment

**Framework detector (future)**:
Posible módulo read-only para aportar evidencia de un framework sobre una project
unit. Queda fuera de v1 y sólo se incorporará si aparece una necesidad demostrada; no
se integrará dentro de un stack adapter ni de un harness adapter.
_Avoid_: Stack adapter, recommendation rule

**Harness adapter**:
Traducción versionada entre componentes portables y las superficies, precedencia,
capabilities y probes que un harness concreto reconoce. Produce intenciones; no escribe.
Cuando el contexto dice sólo “adapter”, se refiere a este contrato salvo calificación.
_Avoid_: Installer, stack adapter, copy strategy

**Artifact intent**:
Descripción inmutable de un cambio de archivo que un harness adapter solicita al
planner. Incluye owner, destino relativo, operación, digest, precondiciones y
validaciones; sólo el motor de mutaciones puede ejecutarla.
_Avoid_: File write, side effect

**Managed section**:
Envelope delimitado que AI Harness posee de forma autoritativa dentro de un archivo
del consumidor. Incluye markers, body y el separador estructural introducido; puede
reescribirse sin atribuir ownership al resto del archivo.
_Avoid_: Generated file

**Managed unit**:
Unidad mínima de ownership registrada en el lock: un archivo completo creado por AI
Harness o una managed section delimitada dentro de un container compartido. Su estado
locked es autoritativo; una edición manual interna puede ser reemplazada por repair o
retirada por remove después del plan normal.
_Avoid_: Destination file, observed path

**Direct selection**:
Componente o pack elegido explícitamente por el usuario o por una invocación
automatizada.
_Avoid_: Root dependency

**Applicability evidence**:
Relación observada entre los lenguajes declarados por un componente y las project
units detectadas. Orienta recomendaciones y explicaciones; no autoriza ni prohíbe una
Direct selection.
_Avoid_: Compatibility gate, installation permission

**Transitive requirement**:
Componente agregado porque una selección directa no sería válida o completa sin él.
_Avoid_: Recommendation

**Inclusion cause**:
Relación inmediata `includes` o `requires` que justifica la presencia de un componente
en el cierre resuelto. Un componente conserva todas sus causas sin duplicar identidad.
_Avoid_: Primary cause, execution call

**Recommendation**:
Componente o pack sugerido a partir de evidencia del repositorio y del entorno; no
se instala hasta formar parte de una selección aprobada.
_Avoid_: Dependency, default install

**Desired state**:
Selecciones directas, harnesses objetivo y políticas que el consumidor espera que AI
Harness mantenga para un repositorio. Expresa intención; nunca demuestra por sí solo
que un componente o artefacto esté instalado.
_Avoid_: Lock state, installed files

**Draft**:
Propuesta en memoria del desired state mientras se editan Direct selections, targets e
inputs. No posee artefactos ni autoriza escrituras; debe resolverse y convertirse en un
plan antes de poder aprobarse.
_Avoid_: Desired state, plan, pending install

**Interaction session**:
Contexto de una ejecución que conserva el mismo observed snapshot, draft, resolución,
plan revisado y secuencia de eventos para todas las superficies de entrada. No sustituye
el estado portable ni sobrevive como evidencia de instalación.
_Avoid_: TUI state, CLI command, local operation state

**Component removal**:
Transición del desired state que retira una Direct selection y conserva cualquier
componente todavía alcanzado por otra causa. No significa borrar archivos por nombre.
_Avoid_: Recursive delete, force uninstall

**Unmanage (future)**:
Posible transición que preservaría bytes administrados mientras retira ownership. No
existe en v1: el usuario mantiene y reconcilia la selección o la retira mediante el
flujo normal de Component removal.
_Avoid_: Remove, ignore drift

**Resolution**:
Cierre determinista y explicable de las Direct selections sobre un Catalog snapshot,
incluyendo requisitos, aplicabilidad, recomendaciones, asociaciones y blockers.
_Avoid_: Plan, installed state

**Blocked resolution preview**:
Resultado explicable de una resolución con blockers que conserva cierre y causas, pero
no puede convertirse en un plan.
_Avoid_: Partial plan, failed apply

**Lock state**:
Resolución exacta y reproducible del desired state, incluyendo identidades, versiones,
relaciones, adapters, destinos y hashes administrados. Aporta trazabilidad esperada y
ownership, pero debe contrastarse con el estado observado antes de afirmar presencia.
_Avoid_: Cache, desired state

**Observed state**:
Evidencia actual obtenida por scan desde el filesystem, la configuración local y las
superficies verificables de cada harness. Es independiente de lo que declaren desired
state y lock state; un path declarado pero ausente continúa ausente.
_Avoid_: Desired state, lock state

**State reconciliation**:
Comparación determinista entre desired state, lock state y observed state que clasifica
materialización limpia, pendiente, ausente, con drift, foreign o no verificable. Detecta
inconsistencias y produce acciones seguras; el scan que la calcula no repara.
_Avoid_: Resolution, automatic install

**Local operation state**:
Estado no versionado del clon o worktree: operation lock, planes temporales, journals,
backups, cache, paths resueltos y activación local de Git. Vive bajo el git-dir efectivo
y nunca forma parte del lock portable.
_Avoid_: Lock state, desired state

**Recovery rollback**:
Compensación verificada de una transacción cuyo journal quedó abierto. Se intenta antes
de aceptar otra mutación y nunca reanuda el plan interrumpido. Si el journal y el estado
observado ya no demuestran una restauración segura, se detiene con recovery requerido
sin sobrescribir cambios posteriores.
_Avoid_: Resume, repair, recursive cleanup

**Drift**:
Diferencia observada dentro de una managed unit entre su digest locked y su contenido
actual. Cambios fuera de una managed section no son drift; cambios internos quedan
bajo el riesgo explícito de ser reescritos por la reconciliación autoritativa.
_Avoid_: Update, user content

**Readiness**:
Veredicto que indica si están presentes las capacidades, permisos y prerrequisitos
necesarios para ejecutar un plan concreto.
_Avoid_: Installed, recommendation

**Diagnostic**:
Explicación clasificada con código estable, evidencia, impacto y acción segura sobre
una condición observada por AI Harness.
_Avoid_: Raw exception, log line

**Plan**:
Conjunto inmutable e identificable de cambios, precondiciones y verificaciones que
materializaría un desired state sobre un scan específico.
_Avoid_: Desired state, command log

**Plan approval**:
Autorización explícita que nombra el ID exacto de un plan inmutable. No autoriza a
reescanear, volver a resolver ni sustituir silenciosamente el plan aprobado.
_Avoid_: Confirmation, yes flag without a plan

**Operation event**:
Observación estructurada y ordenada del estado o una tarea de una Interaction session.
Alimenta por igual progreso TUI y NDJSON; no es una línea de log ni una regla de negocio.
_Avoid_: Log line, UI event

**Receipt**:
Resultado inmutable de una operación que separa verdict global, materialización,
certificación, outcomes y diagnósticos sin afirmar el estado actual futuro del repo.
_Avoid_: Status, log, lock state

**Certified runtime baseline**:
Líneas y pisos de versión que AI Harness acepta para instalar y ejecutar una release,
respaldados por una matriz de compatibilidad explícita. No describe las herramientas
exactas que produjeron sus bytes.
_Avoid_: Build toolchain identity, latest

**Build toolchain identity**:
Conjunto exacto e inmutable de runtimes, herramientas, dependencias y lockfile que
produce un candidato de release. No amplía por sí mismo la compatibilidad del runtime
consumidor.
_Avoid_: Certified runtime baseline, development environment

**Release identity**:
Hechos inmutables que vinculan una versión y sus artefactos con la fuente, catálogo,
toolchain y evidencia que los produjeron. Un SemVer o digest aislado no constituye la
identidad completa.
_Avoid_: Version, tarball hash
