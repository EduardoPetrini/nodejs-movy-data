{{/*
Short, because a runner Job's name is `<fullname>-runner-<class>-<5 random>`
and becomes its pods' `job-name` label, which Kubernetes caps at 63
characters. `movy.validateClasses` checks the sum.
*/}}
{{- define "movy.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 20 | trimSuffix "-" -}}
{{- else if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 20 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 20 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "movy.labels" -}}
app.kubernetes.io/name: movy
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* (dict "root" $ "component" "web") */}}
{{- define "movy.selector" -}}
app.kubernetes.io/name: movy
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "movy.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* The `build` target: migrate and seed need drizzle-kit and tsx, which are devDependencies. */}}
{{- define "movy.toolsImage" -}}
{{- printf "%s:%s" .Values.toolsImage.repository (.Values.toolsImage.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "movy.secret.movy" -}}{{ include "movy.fullname" . }}-console{{- end -}}
{{- define "movy.secret.runner" -}}{{ include "movy.fullname" . }}-runner{{- end -}}
{{- define "movy.secret.scaler" -}}{{ include "movy.fullname" . }}-scaler{{- end -}}
{{- define "movy.secret.metaDb" -}}{{ include "movy.fullname" . }}-meta-db{{- end -}}
{{- define "movy.secret.lab" -}}{{ include "movy.fullname" . }}-lab{{- end -}}

{{/* `<prefix><class>` is a Deployment class's Deployment; the console reads the prefix as MOVY_K8S_DEPLOYMENT_PREFIX. */}}
{{- define "movy.runnerPrefix" -}}{{ include "movy.fullname" . }}-runner-{{- end -}}

{{/* MOVY_K8S_JOB_CLASSES: the classes KEDA starts a Job for. */}}
{{- define "movy.jobClasses" -}}
{{- $names := list -}}
{{- range .Values.runnerClasses -}}
{{- if eq .mode "job" }}{{ $names = append $names .name }}{{ end -}}
{{- end -}}
{{- join "," $names -}}
{{- end -}}

{{- define "movy.metaDb.host" -}}
{{- if .Values.metaDb.bundled -}}
{{- include "movy.fullname" . }}-meta-db
{{- else -}}
{{- required "metaDb.host is required unless metaDb.bundled is true" .Values.metaDb.host -}}
{{- end -}}
{{- end -}}

{{/*
A secret value that survives `helm upgrade`: the value given in values, else
the one already stored in the release's Secret, else a fresh one. Without the
middle step every upgrade would mint a new NUXT_ENCRYPTION_KEY and make every
saved connection undecryptable — `docker:init` refuses to overwrite for the
same reason. `helm template` has no cluster, so there it always mints.
(dict "ns" "name" "key" "given" "fresh")
*/}}
{{- define "movy.keep" -}}
{{- $stored := "" -}}
{{- $secret := lookup "v1" "Secret" .ns .name -}}
{{- if and $secret $secret.data -}}
{{- $stored = index $secret.data .key | default "" | b64dec -}}
{{- end -}}
{{- coalesce .given $stored .fresh | default "" -}}
{{- end -}}

{{/*
The one list of classes drives the Deployments, the ScaledJobs, the class file
and MOVY_K8S_JOB_CLASSES, so it is checked once, here, by the rules the
runner's `parseRunnerClassesFile` applies at boot — a typo fails the install,
not a pod.
*/}}
{{- define "movy.validateClasses" -}}
{{- $seen := dict -}}
{{- $defaults := 0 -}}
{{- range .Values.runnerClasses -}}
{{- if not (regexMatch "^[a-z][a-z0-9-]{0,31}$" (toString .name)) -}}
{{- fail (printf "runnerClasses: %q must be lowercase letters, digits and dashes, starting with a letter (at most 32)" (toString .name)) -}}
{{- end -}}
{{- if eq .name "web" }}{{ fail "runnerClasses: \"web\" is reserved: Test and Preview read it as the console" }}{{ end -}}
{{- if hasKey $seen .name }}{{ fail (printf "runnerClasses: %q is listed twice" .name) }}{{ end -}}
{{- $_ := set $seen .name true -}}
{{- if not (has .mode (list "deployment" "job")) -}}
{{- fail (printf "runnerClasses: %q has mode %q; it must be deployment or job" .name (toString .mode)) -}}
{{- end -}}
{{- if not .label }}{{ fail (printf "runnerClasses: %q needs a label" .name) }}{{ end -}}
{{- $label := trim (toString .label) -}}
{{- if or (eq (len $label) 0) (gt (len $label) 40) -}}
{{- fail (printf "runnerClasses: %q label is required, at most 40 characters" .name) -}}
{{- end -}}
{{- if or (not .cpuMillis) (not .memoryMb) }}{{ fail (printf "runnerClasses: %q needs cpuMillis and memoryMb" .name) }}{{ end -}}
{{- $c := . -}}
{{- range $field, $min := dict "cpuMillis" 1 "memoryMb" 1 "maxReplicas" 0 "suggestAboveBytes" 1 "slots" 1 "replicas" 0 -}}
{{- if and (hasKey $c $field) (not (kindIs "invalid" (index $c $field))) -}}
{{- include "movy.wholeNumber" (dict "class" $c.name "field" $field "value" (index $c $field) "min" $min) -}}
{{- end -}}
{{- end -}}
{{- if and (eq .mode "deployment") (gt (int (include "movy.count" (dict "class" . "field" "replicas" "default" 1))) (int (include "movy.count" (dict "class" . "field" "maxReplicas" "default" 1)))) -}}
{{- fail (printf "runnerClasses: %q replicas (%s) is above its maxReplicas (%s)" .name (include "movy.count" (dict "class" . "field" "replicas" "default" 1)) (include "movy.count" (dict "class" . "field" "maxReplicas" "default" 1))) -}}
{{- end -}}
{{- if and (eq .mode "job") (gt (len (printf "%s%s-xxxxx" (include "movy.runnerPrefix" $) .name)) 63) -}}
{{- fail (printf "runnerClasses: %q makes Job names past 63 characters; shorten it or fullnameOverride" .name) -}}
{{- end -}}
{{- if .default }}{{ $defaults = add1 $defaults }}{{ end -}}
{{- end -}}
{{- if ne $defaults 1 }}{{ fail "runnerClasses: exactly one class must be default: true" }}{{ end -}}
{{- end -}}

{{/*
The same whole-number rule `parseRunnerClassesFile` applies at boot, so a value
the console would refuse fails the render instead.
(dict "class" name "field" name "value" v "min" n)
*/}}
{{- define "movy.wholeNumber" -}}
{{- $v := .value -}}
{{- $isNumber := or (kindIs "int" $v) (kindIs "int64" $v) (kindIs "float64" $v) -}}
{{- if or (not $isNumber) (and $isNumber (or (ne (float64 $v) (floor $v)) (lt (float64 $v) (float64 .min)))) -}}
{{- fail (printf "runnerClasses: %q %s must be a whole number of at least %d" .class .field (int .min)) -}}
{{- end -}}
{{- end -}}

{{/*
A count that may legitimately be 0. `| default 1` reads 0 as unset and turns
it into 1 without a word, so only an absent field takes the default.
(dict "class" $class "field" name "default" n)
*/}}
{{- define "movy.count" -}}
{{- $v := index .class .field -}}
{{- if and (hasKey .class .field) (not (kindIs "invalid" $v)) }}{{ int64 $v }}{{ else }}{{ .default }}{{ end -}}
{{- end -}}

{{/*
A Deployment class's replicas: the values' count, or the live Deployment's when
that is larger. "Start a runner" writes `.spec.replicas` through the scale
subresource, which takes ownership of the field, and Helm 4 applies
server-side: rendering a different count fails the upgrade on that conflict,
and forcing it would remove the started runner mid-run. Re-applying the live
value is no conflict. Raising the count in values still works; lowering it
below the live one is `kubectl scale`. Without a cluster (`helm template`,
GitOps) `lookup` is empty and the values' count renders.
(dict "root" $ "class" .)
*/}}
{{- define "movy.replicas" -}}
{{- $want := include "movy.count" (dict "class" .class "field" "replicas" "default" 1) | int64 -}}
{{- $live := lookup "apps/v1" "Deployment" .root.Release.Namespace (printf "%s%s" (include "movy.runnerPrefix" .root) .class.name) -}}
{{- if and $live $live.spec (hasKey $live.spec "replicas") -}}
{{- max $want (int64 $live.spec.replicas) -}}
{{- else -}}
{{- $want -}}
{{- end -}}
{{- end -}}

{{/*
A password inside a URL's userinfo. `urlquery` is a query-string escape and
writes a space as `+`, which a URL reads back as a literal plus; it escapes a
real `+` as %2B, so every `+` left is a space.
*/}}
{{- define "movy.urlPart" -}}
{{- urlquery . | replace "+" "%20" -}}
{{- end -}}

{{/*
A class's cpuMillis/memoryMb as Kubernetes spells them canonically: "1", not
"1000m"; "1Gi", not "1024Mi". KEDA's operator rewrites a ScaledJob's
quantities into that form and takes ownership of them, so any other spelling
makes the next server-side apply (`helm upgrade`) a field conflict.
*/}}
{{- define "movy.quantities" -}}
{{- $cpu := int .cpuMillis -}}
{{- $mem := int .memoryMb -}}
cpu: {{ ternary (printf "%d" (div $cpu 1000)) (printf "%dm" $cpu) (eq (mod $cpu 1000) 0) | quote }}
memory: {{ ternary (printf "%dGi" (div $mem 1024)) (printf "%dMi" $mem) (eq (mod $mem 1024) 0) | quote }}
{{- end -}}

{{/*
A runner agent's pod. (dict "root" $ "class" $class "job" bool)
Only the runner Secret: the movy_runner role and the encryption key, never the
owner's password or the session secret.
*/}}
{{- define "movy.runnerPod" -}}
{{- $v := .root.Values -}}
{{- $c := .class -}}
automountServiceAccountToken: false
terminationGracePeriodSeconds: {{ $v.runner.terminationGracePeriodSeconds }}
{{- if .job }}
# A dead runner is settled RunnerVanished, never resumed: no retries, ever.
restartPolicy: Never
{{- end }}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
{{- with $v.runner.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $v.runner.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  - name: agent
    image: {{ include "movy.image" .root }}
    imagePullPolicy: {{ $v.image.pullPolicy }}
    workingDir: /app
    # `args`, not `command`: a command would replace the image's tini
    # entrypoint, which reaps the runner processes the agent forks.
    args: [node, apps/runner/dist/agent-main.js]
    env:
      - { name: MOVY_RUNNER_CLASS, value: {{ $c.name | quote }} }
      - { name: MOVY_RUNNER_SLOTS, value: {{ $c.slots | default 1 | quote }} }
      # Pod-local: the database is the record. Lost with the pod, which is
      # why a runner that dies is settled, never resumed.
      - { name: MOVY_JOURNAL_DIR, value: /data/runs }
      - { name: MOVY_RUNNER_DRAIN_MS, value: {{ $v.runner.drainMs | quote }} }
      - { name: MOVY_SIMULATION_FIXTURE, value: /app/apps/runner/fixtures/pg-to-pg-315k.ndjson }
      - { name: MOVY_RUNNER_HEALTH_PORT, value: {{ $v.runner.healthPort | quote }} }
      {{- if .job }}
      # Job mode: one claim, then exit once it settles; idle, exit after this.
      # Only Job pods: a Deployment would restart a pod that exits.
      - { name: MOVY_RUNNER_MAX_RUNS, value: "1" }
      - { name: MOVY_RUNNER_PROVISIONED_BY, value: kubernetes-job }
      - { name: MOVY_RUNNER_IDLE_EXIT_MS, value: {{ $v.runner.jobIdleExitMs | quote }} }
      {{- end }}
    envFrom:
      - secretRef: { name: {{ include "movy.secret.runner" .root }} }
    ports:
      - { name: health, containerPort: {{ $v.runner.healthPort }} }
    # /livez never reads the meta-db: an outage must not restart every runner
    # and kill every live run. Fencing handles losing the database.
    livenessProbe:
      httpGet: { path: /livez, port: health }
      periodSeconds: 10
      failureThreshold: 3
    {{- if not .job }}
    # Not ready while draining or before registering.
    readinessProbe:
      httpGet: { path: /readyz, port: health }
      periodSeconds: 5
    {{- end }}
    {{- $q := include "movy.quantities" $c | fromYaml }}
    resources:
      requests: {{- toYaml $q | nindent 8 }}
      limits: {{- toYaml $q | nindent 8 }}
    securityContext:
      allowPrivilegeEscalation: false
      capabilities: { drop: [ALL] }
    volumeMounts:
      - { name: journals, mountPath: /data/runs }
volumes:
  - name: journals
    emptyDir: {}
{{- end -}}
