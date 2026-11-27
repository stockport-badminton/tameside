
# Readme


## useful find and replace for SQL => postgres
```
find: (?!JOIN|join|oin|concat|oncat)([tamevgsortsinnplyIdhcwvuMkLfx_]{2,20})([uTUkSvwchtNCbamevDgLPsFortsAinWnplyId12]{3,20})
replace: "$1$2"
```


## gcloud build / deploy

Deploys are automatic: pushing to `main` fires the Cloud Build trigger
`tameside-site-main` (region `europe-west2`), which runs
`cloudbuild.yaml` (build → push → `gcloud run services update`). Builds run in
europe-west2 too, so `gcloud builds list` needs `--region=europe-west2`.

To re-run that same pipeline by hand:
```
gcloud builds submit --region=europe-west2 --config cloudbuild.yaml
```

Images live at
`europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameside/tameside-site`.
Each build pushes `:$COMMIT_SHA` (what the Cloud Run revision pins to) and `:latest`,
which is read only as the next build's layer cache — don't stop pushing `:latest`, or
every build goes cold again.

## local docker build / run

```
docker build . --tag tameside-site:local
```

```
PORT=8080 && docker run -p 8080:${PORT} -e PORT=${PORT} --env-file .env tameside-site:local
```

Add `--platform=linux/amd64` on an Apple-silicon machine to match what Cloud Run runs.
