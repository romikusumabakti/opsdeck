pipeline {
    agent any

    environment {
        // Path to the .env on the server (outside the workspace so it survives
        // git checkouts). Adjust if you keep it elsewhere.
        ENV_FILE = '/deployments/dss-panel/.env'
    }

    stages {
        stage('Deploy') {
            steps {
                sh "cp ${ENV_FILE} .env"
                sh "docker compose up -d --build --remove-orphans"
            }
        }
    }
}
