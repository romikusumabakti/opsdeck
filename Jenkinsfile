pipeline {
    agent any

    environment {
        POSTGRES_PASSWORD  = credentials('opsdeck-postgres-password')
        BETTER_AUTH_SECRET = credentials('opsdeck-better-auth-secret')
        RESEND_API_KEY     = credentials('opsdeck-resend-api-key')
    }

    stages {
        stage('Deploy') {
            steps {
                sh "docker compose up -d --build"
            }
        }
    }
}
