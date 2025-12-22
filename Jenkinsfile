pipeline {
    agent any

    stages {
        stage('Deploy') {
            steps {
                sh """
                    docker compose up -d &&
                    docker image prune -a -f
                """
            }
        }
    }
}
