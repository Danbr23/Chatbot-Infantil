// src/pages/Dashboard.jsx
import React, { useState } from "react";
import { useRobots } from "../hooks/useRobots";
import "./Dashboard.css";

const Icons = {
    Plus: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    Eye: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>,
    Trash: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    Broom: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 22l10-10"></path><path d="M14.5 9.5L19 14l-5 5"></path><path d="M17 12l2-2"></path></svg>,
    Logout: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
};

const Dashboard = ({ user, onLogout }) => {
    const { robots, loading, addRobot, removeRobot, clearRobotHistory } = useRobots(user);

    const [modalType, setModalType] = useState(null);
    const [selectedRobot, setSelectedRobot] = useState(null);
    const [formData, setFormData] = useState({ name: "", code: "", params: "" });

    const openAddModal = () => {
        setFormData({ name: "", code: "", params: "" });
        setModalType("add");
    };

    const openHistoryModal = (robot) => {
        setSelectedRobot(robot);
        setModalType("history");
    };

    const closeModal = () => {
        setModalType(null);
        setSelectedRobot(null);
    };

    const handleAddSubmit = async (e) => {
        e.preventDefault();
        if (!formData.code.trim() || !formData.name.trim()) return;

        const success = await addRobot(formData.name, formData.code, formData.params);
        if (success) {
            closeModal();
            window.location.reload();
        }
    };

    return (
        <div className="dashboard-container">
            {/* Fundo limpo, sem formas bg-shape */}

            <header className="dashboard-header">
                <div className="header-content">
                    <div>
                        <h2>Painel de Controle</h2>
                        <span className="user-email">Usuário: {user?.profile?.email}</span>
                    </div>
                    <button className="btn-logout" onClick={onLogout}>
                        Sair <Icons.Logout />
                    </button>
                </div>
            </header>

            <main className="dashboard-content">
                <div className="grid-layout">

                    <aside className="sidebar-column">
                        <div className="glass-card">
                            <h3>Gerenciamento</h3>
                            <p className="card-desc">Adicione novos hardwares para monitoramento remoto.</p>
                            <button onClick={openAddModal} className="btn-primary-full">
                                <Icons.Plus /> Vincular Novo Dispositivo
                            </button>
                        </div>
                    </aside>

                    <section className="main-column">
                        <div className="glass-card">
                            <div className="card-header-row">
                                <h3>Dispositivos Ativos</h3>
                                <span className="badge-counter">{robots.length}</span>
                            </div>

                            {robots.length === 0 && !loading && (
                                <p className="empty-state">Nenhum dispositivo encontrado.</p>
                            )}

                            <div className="robots-list">
                                {robots.map((robot) => (
                                    <div key={robot.robo_id} className="robot-item">
                                        <div className="robot-avatar">
                                            {robot.robo_nome.charAt(0).toUpperCase()}
                                        </div>

                                        <div className="robot-info">
                                            <strong>{robot.robo_nome}</strong>
                                            <span className="robot-code">{robot.robo_codigo}</span>
                                            <small style={{ display: 'block', color: '#888', marginTop: 4 }}>Status: {robot.robo_status || 'ATIVO'}</small>
                                        </div>

                                        <div className="robot-actions">
                                            <button className="btn-icon" onClick={() => openHistoryModal(robot)} title="Ver Histórico">
                                                <Icons.Eye />
                                            </button>
                                            <button className="btn-icon" onClick={() => { if (window.confirm(`Limpar logs de ${robot.robo_nome}?`)) clearRobotHistory(robot.robo_id) }} title="Limpar Logs">
                                                <Icons.Broom />
                                            </button>
                                            <button className="btn-icon delete" onClick={() => { if (window.confirm("Tem certeza que deseja desvincular este hardware?")) removeRobot(robot.robo_id) }} title="Desvincular">
                                                <Icons.Trash />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>
                </div>
            </main>

            {/* Modais */}
            {modalType && (
                <div className="modal-overlay" onClick={closeModal}>
                    <div className="modal-card" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>{modalType === "add" ? "Vincular Novo Dispositivo" : `Histórico: ${selectedRobot?.robo_nome}`}</h3>
                            <button className="btn-close" onClick={closeModal}>&times;</button>
                        </div>

                        <div className="modal-body">
                            {modalType === "add" && (
                                <form onSubmit={handleAddSubmit} className="add-form">
                                    <label>Nome do Dispositivo</label>
                                    <input
                                        type="text"
                                        placeholder="Ex: Rogerinho"
                                        value={formData.name}
                                        onChange={e => setFormData({ ...formData, name: e.target.value })}
                                        required
                                    />

                                    <label>Código do Brinquedo (UUID)</label>
                                    <input
                                        type="text"
                                        placeholder="Ex: ESP32-X92"
                                        value={formData.code}
                                        onChange={e => setFormData({ ...formData, code: e.target.value })}
                                        required
                                    />

                                    <label>Parâmetros Iniciais</label>
                                    <textarea
                                        rows="5"
                                        placeholder="Escolha as configurações que definem como a IA interage..."
                                        value={formData.params}
                                        onChange={e => setFormData({ ...formData, params: e.target.value })}
                                    />

                                    <div className="modal-actions">
                                        <button type="button" onClick={closeModal} className="btn-cancel">Cancelar</button>
                                        <button type="submit" disabled={loading} className="btn-confirm">
                                            {loading ? "Processando..." : "Vincular"}
                                        </button>
                                    </div>
                                </form>
                            )}

                            {modalType === "history" && selectedRobot && (
                                <div className="log-viewer">
                                    <p>Visualizando dados de: <strong>{selectedRobot.robo_codigo}</strong></p>
                                    <pre className="log-content">
                                        {selectedRobot.conteudo_conversa || "Nenhum histórico disponível."}
                                    </pre>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;