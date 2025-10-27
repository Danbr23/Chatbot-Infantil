import threading
import time
import RPi.GPIO as GPIO

class MotorController(threading.Thread):
    PARADO = "parado"
    FRENTE = "frente"
    TRAS = "tras"
    ESQUERDA = "esquerda"
    DIREITA = "direita"

    def __init__(self, in1=17, in2=27, in3=22, in4=23, delay=0.02):
        super().__init__(daemon=True)
        self.IN1 = in1
        self.IN2 = in2
        self.IN3 = in3
        self.IN4 = in4
        self.delay = delay

        self._estado = self.PARADO
        self._lock = threading.Lock()
        self._running = False   # <- comeÃ§a desativado
        self._ativo = False     # <- motor inicialmente desativado

    def ativar(self):
        """Inicializa GPIO e ativa controle dos motores."""
        if self._ativo:
            return  # jÃ¡ estÃ¡ ativo
        self._ativo = True
        GPIO.setmode(GPIO.BCM)
        for pin in [self.IN1, self.IN2, self.IN3, self.IN4]:
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, GPIO.LOW)
        self._running = True
        self.start()

    def desativar(self):
        """Desliga os pinos e limpa GPIO completamente."""
        self.parar()
        self._running = False
        self._ativo = False
        for pin in [self.IN1, self.IN2, self.IN3, self.IN4]:
            GPIO.output(pin, GPIO.LOW)
        GPIO.cleanup()

    def run(self):
        """Loop contÃ­nuo para atualizar pinos conforme estado."""
        while True:
            if not self._running:
                time.sleep(0.05)
                continue

            with self._lock:
                estado = self._estado

            if estado == self.PARADO:
                self._set_pinos(0, 0, 0, 0)
            elif estado == self.FRENTE:
                self._set_pinos(0, 1, 0, 1)
            elif estado == self.TRAS:
                self._set_pinos(1, 0, 1, 0)
            elif estado == self.ESQUERDA:
                self._set_pinos(1, 0, 0, 1)
            elif estado == self.DIREITA:
                self._set_pinos(0, 1, 1, 0)

            time.sleep(self.delay)

    def _set_pinos(self, a1, a2, b1, b2):
        GPIO.output(self.IN1, GPIO.HIGH if a1 else GPIO.LOW)
        GPIO.output(self.IN2, GPIO.HIGH if a2 else GPIO.LOW)
        GPIO.output(self.IN3, GPIO.HIGH if b1 else GPIO.LOW)
        GPIO.output(self.IN4, GPIO.HIGH if b2 else GPIO.LOW)

    # ---------- MÃ©todos de controle ----------
    def frente(self):
        with self._lock:
            self._estado = self.FRENTE

    def tras(self):
        with self._lock:
            self._estado = self.TRAS

    def esquerda(self):
        with self._lock:
            self._estado = self.ESQUERDA

    def direita(self):
        with self._lock:
            self._estado = self.DIREITA

    def parar(self):
        with self._lock:
            self._estado = self.PARADO
