pipeline {
    agent any

    environment {
        POSTGRES_PASSWORD  = credentials('dss-panel-postgres-password')
        BETTER_AUTH_SECRET = credentials('dss-panel-better-auth-secret')
        RESEND_API_KEY     = credentials('dss-panel-resend-api-key')
    }

    stages {
        stage('Deploy') {
            steps {
                sh "docker compose up -d --build"
            }
        }
    }
}
