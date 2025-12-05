// src/hooks/useRobots.js
import { useState, useEffect, useCallback } from "react"; // <--- Importe o useCallback
import { robotService } from "../services/robotService";

export const useRobots = (user) => {
  const [robots, setRobots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // --- 1. Use useCallback para memorizar a função ---
  // Isso garante que getToken não mude de referência a cada render,
  // satisfazendo o useEffect e o linter.
  const getToken = useCallback(() => {
    return (
      user?.id_token ||
      user?.access_token ||
      user?.signInUserSession?.idToken?.jwtToken
    );
  }, [user]); // Só recria se 'user' mudar

  // --- Busca Inicial ---
  useEffect(() => {
    if (!user) return;

    let isMounted = true;
    setLoading(true);

    // Agora podemos chamar getToken tranquilamente
    const token = getToken();

    if (!token) {
      console.error("Token não encontrado!");
      setLoading(false);
      return;
    }

    robotService
      .getAll(token)
      .then((data) => {
        if (isMounted) {
          if (Array.isArray(data)) {
            setRobots(data);
            setError(null);
          } else {
            console.error("API não retornou um array:", data);
            setRobots([]);
            if (data?.message) setError(data.message);
          }
        }
      })
      .catch((err) => {
        console.error(err);
        if (isMounted) setError("Falha ao carregar robôs.");
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [user, getToken]); // <--- Agora incluímos getToken nas dependências sem medo

  // --- Ações ---

  const addRobot = async (name, code, params) => {
    setLoading(true);
    const token = getToken(); // Reutiliza a função memorizada

    if (!token) return false;

    try {
      const response = await robotService.create(name, code, params, token);

      // Tratamento para garantir que estamos adicionando um objeto
      const newRobot = Array.isArray(response) ? response[0] : response;

      setRobots((prev) => [...prev, newRobot]);
      return true;
    } catch (err) {
      console.error(err);
      setError(err.message || "Erro ao criar robô.");
      return false;
    } finally {
      setLoading(false);
    }
  };

  const removeRobot = async (targetId) => {
    const previousState = [...robots];

    // Atualiza a tela IMEDIATAMENTE (Optimistic UI)
    setRobots((currentRobots) =>
      currentRobots.filter((r) => r.robo_id !== targetId)
    );

    const token = getToken();
    if (!token) {
      setRobots(previousState);
      return;
    }

    try {
      await robotService.delete(targetId, token);
    } catch (err) {
      console.error("Erro ao deletar, revertendo estado:", err);
      setRobots(previousState);
      alert("Erro ao excluir. Tente novamente.");
    }
  };

  const clearRobotHistory = async (targetId) => {
    const token = getToken();
    if (!token) return;

    try {
      setLoading(true);
      await robotService.clearHistory(targetId, token);

      setRobots((prev) =>
        prev.map((r) =>
          r.robo_id === targetId ? { ...r, conteudo_conversa: "" } : r
        )
      );
    } catch (err) {
      console.error(err);
      alert("Erro ao limpar histórico: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return { robots, loading, error, addRobot, removeRobot, clearRobotHistory };
};
