
# Readme


## useful find and replace for SQL => postgres
```
find: (?!JOIN|join|oin|concat|oncat)([tamevgsortsinnplyIdhcwvuMkLfx_]{2,20})([uTUkSvwchtNCbamevDgLPsFortsAinWnplyId12]{3,20})
replace: "$1$2"
```


## gcloud build / deploy
```
gcloud builds submit --region=global --config cloudbuild.yaml
```

```
gcloud run deploy tameside-site --image europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameide-image:tag1
```

## local docker build / run

```
docker build . --tag europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameide-image:latest
```

```
PORT=8080 && docker run -p 8080:${PORT} -e PORT=${PORT} europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameide-image:latest                  
```
