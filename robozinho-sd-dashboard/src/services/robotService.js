// src/services/robotService.js
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

const setAuthHeader = (token) => ({
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

export const robotService = {
  async getAll(token) {
    if (!token) return [];

    try {
      const res = await api.get("/robots", setAuthHeader(token));
      return Array.isArray(res.data) ? res.data : [];
    } catch (error) {
      console.error("Erro no getAll:", error);
      throw error; // Lança o erro para o hook tratar (exibir msg)
    }
  },

  async create(name, code, params, token) {
    // Enviando no formato que o backend espera
    // Nota: Se seu backend espera snake_case (robo_nome), ajuste aqui.
    // Estou mantendo conforme seu código original:
    const payload = {
      name,
      code,
      params,
    };

    const res = await api.post("/robots", payload, setAuthHeader(token));
    return res.data; // Espera-se que retorne o objeto criado (com o ID gerado)
  },

  async delete(id, token) {
    await api.delete(`/robots/${id}`, setAuthHeader(token));
    // Não precisa retornar nada se for void, o status 200/204 basta
  },

  async clearHistory(id, token) {
    await api.post(`/robots/${id}/clear-history`, {}, setAuthHeader(token));
  },
};
