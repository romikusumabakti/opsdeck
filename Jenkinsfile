pipeline {
    agent any

    environment {
        DEPLOY_SERVER = "192.168.55.113"
        DEPLOY_USER = "root"

        APP_NAME = "dss-panel"

        DOCKER_REGISTRY = "192.168.55.113:5000"

        APP_CONTAINER = "${APP_NAME}-app"

        BRANCH_NAME = env.GIT_BRANCH.replaceAll('/', '-')
        COMMIT_HASH = sh(returnStdout: true, script: 'git rev-parse --short HEAD').trim()
        IMAGE_TAG = "${BRANCH_NAME}-${COMMIT_HASH}"

        APP_IMAGE = "${DOCKER_REGISTRY}/${APP_CONTAINER}:${IMAGE_TAG}"
    }

    stages {
        stage('Build') {
            steps {
                sh "docker build -t ${APP_IMAGE} ."
            }
        }

        stage('Push') {
            steps {
                sh """
                    docker start registry || docker run -d -p 5000:5000 --name registry registry:2
                    docker push ${APP_IMAGE}
                """
            }
        }

        stage('Deploy') {
            steps {
                sh """
                    mkdir -p /deployments/${APP_NAME}

                    export IMAGE_TAG=${IMAGE_TAG} &&
                    docker pull ${APP_IMAGE} &&
                    cd /deployments/${APP_NAME} &&
                    docker compose up -d &&
                    docker image prune -a -f
                """
            }
        }
    }
}
